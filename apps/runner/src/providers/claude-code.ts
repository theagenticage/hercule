/**
 * The Claude Code provider adapter, and the only file that calls the vendor
 * SDK. The other `claude-code-*` files import only its types.
 *
 * The probe sends no prompt and uses the SDK's control requests instead,
 * because a real prompt would bill the user's account just for opening a Fleet
 * page. The adapter uses only the instance's own config directory, never the
 * user's `~/.claude`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import {
  query as sdkQuery,
  type CanUseTool,
  type EffortLevel,
  type HookCallback,
  type Options,
  type PermissionMode,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type Settings,
} from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_CODE_VERSION } from "@hercule/home/version";
import {
  AdapterFailed,
  AnswerNotDelivered,
  MAX_FACT_ITEMS,
  MAX_MESSAGE_LENGTH,
  SessionNotRunning,
  SteerRefused,
  type AccessMode,
  type AdapterError,
  type ApprovalDecision,
  type DisallowedTool,
  type ExitReason,
  type ModelDescriptor,
  type ModelOption,
  type OpenRequest,
  type ProbeResult,
  type ProviderEvent,
  type QuestionAnswers,
  type SendResult,
  type SessionBinding,
  type SessionSpec,
  type SubagentId,
  type TextGenerationOutcome,
  type TextGenerationSpec,
} from "@hercule/protocol";
import { createChildOwner } from "./claude-code-child";
import {
  decideTextGenerationOutcome,
  normalize,
  buildNormalizingState,
  openTurn,
  classifyTool,
  isAnyAgentWorking,
  type Normalizing,
} from "./claude-code-normalize";
import {
  cleanSubagentId,
  clearRefusedStop,
  collectDescendants,
  deferUntilTurnOpens,
  isMessageWithinSession,
  markStopsWanted,
  takeStopsDue,
  type RequestOpened,
} from "./claude-code-subagents";
import type { AttachmentUploader } from "../attachments";
import type { ResolvedSkillReference } from "../skills";
import { buildSkillSteerRefusedMessage } from "./steer-refused-message";
import {
  buildHarnessNotInstalled,
  buildHarnessStartFailed,
  buildInputStopped,
  buildModelChangeRefused,
  buildSessionAlreadyRunning,
  buildSessionNotRunning,
  buildSessionStopping,
} from "./adapter-error-builders";
import { readAttachmentBase64 } from "./attachments";
import { replaceToolResultImages } from "./claude-code-tool-result-images";
import {
  FILE_WRITING_TOOL_MATCHER,
  buildStartMarkHook,
  trackShellProcess,
} from "./claude-code-edit-marks";
import type {
  AdapterTurnInput,
  EditMarks,
  ProviderAdapter,
  ProviderRunnerContext,
  TextGenerationContext,
} from "./index";
import { makeInstall } from "./install";
import { PROBE_DEADLINE, buildFailedProbe } from "./probe";
import type { LoginCommand } from "./login";
import { runProcess, type Run } from "./process";
import { truncateFact, truncateMessage } from "./text";
import { buildUserMessage, ensureId } from "./events";
import { buildHarnessPrompt, joinInstructions } from "./prompt";
import {
  buildDenyResult,
  openPark,
  withdrawAllParks,
  withdrawParksAskedBy,
  type Parks,
} from "./claude-code-parks";
import { buildQuestionRequest } from "./questions";
import { endSentence, now } from "../report";
import { listNativeClaudeSkills, runBoundedListing } from "../skills";

export const CLAUDE_CODE = "claude-code";

/** The name the user knows this harness by, as it appears in the messages shown to them. */
const CLAUDE_CODE_NAME = "Claude Code";

const CLAUDE_BINARY = "claude";

/**
 * How long a control request may take. A control request writes to the harness
 * child process and waits for its reply. The runner handles a session's frames
 * one at a time, in order, so without a time limit a child that stops
 * responding would hold up every later frame of its session, and the close of
 * a connection, which waits for a start or an input already under way.
 */
export const CONTROL_DEADLINE: Duration.Duration = Duration.seconds(5);

export interface ClaudeSession {
  readonly accountInfo: () => Promise<unknown>;
  readonly supportedModels: () => Promise<ReadonlyArray<unknown>>;
  /** Ends the query. The CLI is a child process, and it does not exit on its own. */
  readonly close: () => void;
}

/**
 * A long-lived streaming `query()`: the messages it yields, and the methods to
 * control and end it. Its input is a stream the adapter pushes turns into. The
 * SDK offers control methods and steering only in this streaming-input mode
 * (spec 06 section 10.1).
 */
export interface ClaudeStream extends AsyncIterable<SDKMessage> {
  /** Ends the turn that is running; the session stays up for the next one. */
  readonly interrupt: () => Promise<void>;
  /** Switches the session's model, starting with the next turn it opens. */
  readonly setModel: (model: string) => Promise<void>;
  /**
   * Stops one subagent, named by its agent id. The SDK then reports the
   * subagent's task as stopped, and the subagent cannot be continued.
   */
  readonly stopTask: (taskId: string) => Promise<void>;
  /**
   * Ends the query. The CLI is a child process, and it does not exit on its
   * own. Returns a promise that never rejects. A session that is stopping
   * ignores it. What it means depends on the `closeWaitsForExit` the stream
   * was made with:
   *
   * - false: it settles when the SDK has finished closing the query, which
   *   the SDK does after waiting about 2 seconds for the CLI to exit,
   *   whether or not the CLI has;
   * - true: it settles only after the CLI process has exited.
   */
  readonly close: () => void | Promise<void>;
}

export interface ClaudeSeam {
  readonly query: (params: { readonly options: Options }) => ClaudeSession;
  readonly stream: (params: {
    readonly options: Options;
    readonly input: AsyncIterable<SDKUserMessage>;
    /**
     * Makes `close()` settle only once the CLI process has exited, by
     * stopping that process itself if the SDK has not. A text generation needs
     * this to free its slot and remove its scratch folder only when nothing
     * is running. A session leaves it out.
     */
    readonly closeWaitsForExit?: boolean;
  }) => ClaudeStream;
  readonly run: Run;
}

interface Account {
  readonly email?: string;
  readonly subscriptionType?: string;
  readonly apiProvider?: string;
  /** Where the harness got its token from; `"none"` when it has no token. */
  readonly tokenSource?: string;
  /** The environment variable the API key came from, when the harness uses an API key. */
  readonly apiKeySource?: string;
}

interface Model {
  readonly value: string;
  readonly displayName: string;
  readonly supportsEffort?: boolean;
  readonly supportedEffortLevels?: ReadonlyArray<string>;
  readonly supportsFastMode?: boolean;
}

const SEMVER = /\d+\.\d+\.\d+\S*/;

/** The effort level the CLI uses when none is chosen. */
const DEFAULT_EFFORT = "medium";

/**
 * Returns the error's message, truncated to fit a `Fact`. An `Error` can have an
 * empty message, which a `Fact` does not accept, so an empty message is
 * replaced with a fixed one.
 */
const describeError = (error: unknown): string => {
  const said = truncateFact(error instanceof Error ? error.message : String(error));
  return said === "" ? "the harness failed with an empty error message" : said;
};

/**
 * Builds the effort option from a list of effort levels. The levels come from
 * the CLI's model list, or from the legacy models below.
 */
function buildEffortOption([first, ...rest]: readonly [
  string,
  ...ReadonlyArray<string>,
]): ModelOption {
  const levels = [first, ...rest];
  return {
    id: "effort",
    label: "Effort",
    kind: "select",
    choices: levels.map((level) => ({
      value: truncateFact(level),
      label: truncateFact(`${level.slice(0, 1).toUpperCase()}${level.slice(1)}`),
    })),
    default: levels.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : first,
  };
}

const FAST_MODE: ModelOption = {
  id: "fastMode",
  label: "Fast mode",
  kind: "boolean",
  default: false,
};

/**
 * Models the CLI no longer lists but still sends to the API. Their options are
 * written by hand, because the CLI's model list no longer describes them.
 */
const LEGACY_MODELS: ReadonlyArray<ModelDescriptor> = [
  {
    slug: "claude-opus-4-8",
    name: "Opus 4.8",
    isLegacy: true,
    imageInput: { maxBytes: null },
    options: [buildEffortOption(["low", "medium", "high"])],
  },
  {
    slug: "claude-fable-5",
    name: "Fable 5",
    isLegacy: true,
    imageInput: { maxBytes: null },
    options: [buildEffortOption(["low", "medium", "high"])],
  },
];

/**
 * Converts a model from the CLI's list into a model descriptor. Adaptive
 * thinking is a property of the model, not a choice, so it is not an option.
 */
const buildModelDescriptor = (model: Model): ModelDescriptor => {
  const options: Array<ModelOption> = [];
  const levels = model.supportedEffortLevels ?? [];
  const [first, ...rest] = levels;
  if (model.supportsEffort === true && first !== undefined) {
    options.push(buildEffortOption([first, ...rest]));
  }
  if (model.supportsFastMode === true) options.push(FAST_MODE);
  return {
    slug: truncateFact(model.value),
    name: truncateFact(model.displayName),
    ...(model.value === "default" ? { isDefault: true } : {}),
    // The CLI's model list has no field for input types, and every Claude
    // model takes images.
    imageInput: { maxBytes: null },
    options,
  };
};

/**
 * Returns the model catalog: the models the CLI listed, then the legacy models
 * it did not list. A listed model replaces a legacy one with the same slug,
 * because the list is what this machine really offers. The catalog is cut to
 * the size the protocol accepts, or the whole report would fail to encode.
 */
const buildCatalog = (models: ReadonlyArray<Model>): ReadonlyArray<ModelDescriptor> => {
  // The protocol does not accept an empty slug or name.
  const probed = models
    .filter((model) => model.value !== "" && model.displayName !== "")
    .map(buildModelDescriptor);
  const listed = new Set(probed.map((model) => model.slug));
  return [...probed, ...LEGACY_MODELS.filter((model) => !listed.has(model.slug))].slice(
    0,
    MAX_FACT_ITEMS,
  );
};

/**
 * Checks whether a credential source is set. The harness reports `"none"` when
 * it has no credential of that kind.
 */
const hasCredentialSource = (source: string | undefined): boolean =>
  source !== undefined && source !== "none";

/**
 * Checks whether the harness has a usable login. That is not the same as
 * knowing the account. A login stored in the instance's own config
 * directory reports an email. A credential passed in through the environment,
 * an OAuth token or an API key, reports only where it came from, and works
 * just as well (spec 06 section 3.2).
 */
const hasCredential = (account: Account): boolean =>
  account.email !== undefined ||
  hasCredentialSource(account.tokenSource) ||
  hasCredentialSource(account.apiKeySource) ||
  // A third-party backend (Bedrock, Vertex, Foundry) authenticates outside the
  // harness, so the harness reports no token source, and it still works.
  (account.apiProvider !== undefined && account.apiProvider !== "firstParty");

/**
 * Returns `{ [key]: value }` with the value truncated to fit a `Fact`, or an
 * empty object when the value is missing or empty. An empty string is not a
 * valid `Fact`, and one would make the whole report fail to encode.
 */
const buildOptionalFact = <K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> => {
  const said = value === undefined ? "" : truncateFact(value);
  return said === "" ? {} : ({ [key]: said } as Record<K, string>);
};

const buildAuth = (account: Account): ProbeResult["auth"] => {
  if (!hasCredential(account)) return { status: "unauthenticated" };
  return {
    status: "ok",
    ...buildOptionalFact("identity", account.email),
    ...buildOptionalFact("planLabel", account.subscriptionType),
    ...buildOptionalFact("backend", account.apiProvider),
  };
};

/**
 * Returns the environment for the CLI, pointed at the instance's config
 * directory. `HOME` is not changed, because overriding it makes the CLI report
 * the login of a different account.
 */
const buildEnv = (ctx: ProviderRunnerContext): Record<string, string | undefined> => ({
  ...ctx.env,
  CLAUDE_CONFIG_DIR: ctx.home,
  // Without this, the harness could update itself during a probe and install
  // a version nobody chose, while the probe is reporting which version it has.
  DISABLE_AUTOUPDATER: "1",
});

/**
 * Returns the SDK options for a probe. The user's own settings and MCP servers
 * are not loaded, because a probe only reads the account and the model list.
 * The CLI still writes into its config directory, which is why the probe uses
 * the instance's own directory.
 */
const buildProbeOptions = (ctx: ProviderRunnerContext, binary: string): Options => ({
  pathToClaudeCodeExecutable: binary,
  settingSources: [],
  strictMcpConfig: true,
  persistSession: false,
  env: buildEnv(ctx),
});

/** Returns an empty prompt. The SDK requires a prompt, and an empty one costs nothing. */
const buildEmptyPrompt = (): AsyncIterable<never> => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined as never }),
  }),
});

/**
 * The input of a live session: an async iterable the adapter pushes turns into,
 * and ends when the session ends. The SDK's `query()` takes its prompt as an
 * iterable, and passing this one keeps the session open for many turns instead
 * of one (spec 06 section 10.1).
 */
interface Pushable<A> extends AsyncIterable<A> {
  readonly push: (value: A) => void;
  readonly end: () => void;
}

const createPushable = <A>(): Pushable<A> => {
  const queued: Array<A> = [];
  const waiting: Array<(result: IteratorResult<A>) => void> = [];
  let ended = false;
  const done: IteratorResult<A> = { done: true, value: undefined as never };
  return {
    push: (value) => {
      const wake = waiting.shift();
      if (wake === undefined) queued.push(value);
      else wake({ done: false, value });
    },
    end: () => {
      ended = true;
      for (const wake of waiting.splice(0)) wake(done);
    },
    [Symbol.asyncIterator]: () => ({
      next: () => {
        if (queued.length > 0) return Promise.resolve({ done: false, value: queued.shift()! });
        if (ended) return Promise.resolve(done);
        return new Promise<IteratorResult<A>>((resolve) => waiting.push(resolve));
      },
    }),
  };
};

/**
 * The SDK permission mode for each access mode (spec 06 section 8.1).
 * `approval-required` maps to the SDK's default mode, which asks for approval
 * through `canUseTool`. The callback is passed in every mode, `full-access`
 * included: without it the harness leaves out `AskUserQuestion` altogether.
 * In `full-access` the harness still calls it for a question and for a tool
 * call that always needs the user's approval (`FULL_ACCESS_NOT_ASKED`).
 */
const PERMISSION_MODES: Readonly<Record<AccessMode, PermissionMode>> = {
  "approval-required": "default",
  "auto-accept-edits": "acceptEdits",
  auto: "auto",
  "full-access": "bypassPermissions",
};

/**
 * The tool input fields that can hold a path. A tool may have none of them (a
 * `Glob` without a directory searches the workspace), so an empty path list is
 * a correct result, not a failure.
 */
const PATH_KEYS: ReadonlyArray<string> = ["file_path", "notebook_path", "path"];

const readInputPaths = (input: Record<string, unknown>): ReadonlyArray<string> =>
  PATH_KEYS.flatMap((key) => {
    const found = input[key];
    return typeof found === "string" && found !== "" ? [truncateFact(found)] : [];
  });

/** The SDK's tool for asking the user questions; it gets a `question` request. */
const ASK_USER_QUESTION = "AskUserQuestion";

/**
 * The message the model reads when a tool call is refused in `full-access`.
 * In `full-access` the harness asks the callback only about a question and
 * about a call that needs the user's approval whatever the mode: a tool the
 * user's or project's settings have an `ask` rule for, a critical-path `rm`
 * or `rmdir`, or an MCP tool that requires user interaction. Full access
 * shows the user no approvals, so nobody can be asked. The harness gives the
 * same refusal when it has no callback at all.
 */
const FULL_ACCESS_NOT_ASKED =
  "Not run: this tool call needs the user's approval, and a session in full access cannot ask the user for it.";

/**
 * Builds the approval the user answers for one tool call other than a
 * question. Every field is truncated to what the protocol accepts: a command
 * or path that is too long would make a frame nobody can decode, which loses
 * the event and leaves the park waiting for ever.
 */
const buildApprovalRequest = (
  requestId: string,
  itemId: string,
  toolName: string,
  input: Record<string, unknown>,
  canPersist: boolean,
): OpenRequest => {
  // "Allow always" is offered only when the harness suggested rules to save.
  // Without them the button would have to invent a rule, which could allow
  // more than the user meant, and an empty set has nothing to save anyway.
  const common = {
    requestId,
    itemId,
    decisions: (canPersist
      ? ["allow", "allow_always", "deny", "cancel"]
      : ["allow", "deny", "cancel"]) as readonly [
      ApprovalDecision,
      ...ReadonlyArray<ApprovalDecision>,
    ],
  };
  const kind = classifyTool(toolName);
  const command = input["command"];
  // Without a command string, a command card has nothing to show.
  if (kind === "command_execution" && typeof command === "string") {
    return { ...common, kind: "command_approval", detail: { command: truncateMessage(command) } };
  }
  if (kind === "file_change") {
    return { ...common, kind: "file_change_approval", detail: { paths: readInputPaths(input) } };
  }
  // A search or a listing reads files too, so it asks the same question as a read.
  if (kind === "file_read" || kind === "file_search") {
    return { ...common, kind: "file_read_approval", detail: { paths: readInputPaths(input) } };
  }
  return { ...common, kind: "tool_approval", detail: { toolName: truncateFact(toolName) } };
};

/**
 * Builds the request the user answers for one `canUseTool` call: a question
 * for `AskUserQuestion`, an approval for any other tool. The request is about
 * the tool call's item, `toolUseId`, cleaned to an id the protocol accepts:
 * an id it does not accept would make a frame nobody can decode, which loses
 * the event and leaves a park no client can see.
 */
const buildToolCallRequest = (
  requestId: string,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
  canPersist: boolean,
): OpenRequest => {
  const itemId = ensureId(toolUseId);
  return toolName === ASK_USER_QUESTION
    ? buildQuestionRequest({ requestId, itemId }, toolName, input["questions"], "question")
    : buildApprovalRequest(requestId, itemId, toolName, input, canPersist);
};

/**
 * Returns the rules the harness suggested saving, each redirected to the
 * session. "Allow always" applies to this thread, not to the user's machine,
 * so no click on it edits a settings file on disk.
 */
const redirectRulesToSession = (
  suggestions: ReadonlyArray<PermissionUpdate> | undefined,
): ReadonlyArray<PermissionUpdate> =>
  (suggestions ?? []).map((rule) => ({ ...rule, destination: "session" as const }));

const EFFORTS: ReadonlyArray<EffortLevel> = ["low", "medium", "high", "xhigh", "max"];

/**
 * Returns the chosen effort level, or `undefined` when none was chosen or the
 * value is not a known level. Effort is the only model option the SDK's options
 * have a field for; `fastMode` has none.
 */
const readEffort = (options: SessionSpec["modelSelection"]["options"]): EffortLevel | undefined => {
  const chosen = options["effort"];
  return EFFORTS.find((level) => level === chosen);
};

/**
 * The most turns a text generation may take. The first turn is the model's
 * answer. With no tools, a second turn happens only when the harness rejected
 * that answer because it did not match the schema and asked the model to try
 * again. One retry fixes the common slip, and a model that fails twice is not
 * worth a third call.
 */
const TEXT_GENERATION_MAX_TURNS = 2;

/**
 * Returns the SDK options for a text generation. It is one model call, so the
 * harness gets nothing a session has:
 *
 * - no tools (the harness adds its own structured-output tool, which is what
 *   answers in the schema);
 * - no setting source, no MCP server and no plugin, so no file on this
 *   machine reaches the prompt;
 * - no saved transcript;
 * - the instructions as the whole system prompt, in place of Claude Code's own;
 * - the cheapest reasoning. Some models still think a little with thinking
 *   disabled, so the lowest effort is set as well.
 *
 * The harness runs in `ctx.cwd`, the empty scratch directory of this call.
 */
const buildTextGenerationOptions = (
  ctx: TextGenerationContext,
  spec: TextGenerationSpec,
): Options => ({
  pathToClaudeCodeExecutable: ctx.binary,
  cwd: ctx.cwd,
  tools: [],
  systemPrompt: spec.instructions,
  outputFormat: { type: "json_schema", schema: spec.outputSchema },
  persistSession: false,
  settingSources: [],
  strictMcpConfig: true,
  model: spec.model,
  thinking: { type: "disabled" },
  effort: "low",
  maxTurns: TEXT_GENERATION_MAX_TURNS,
  env: { ...buildEnv(ctx), CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
});

/**
 * Returns the input of a text generation's harness query: one user message,
 * then the end of the input. The harness answers that message and exits.
 */
const buildTextGenerationInput = (input: string): AsyncIterable<SDKUserMessage> => {
  const messages = createPushable<SDKUserMessage>();
  messages.push({
    type: "user",
    message: { role: "user", content: input },
    parent_tool_use_id: null,
  });
  messages.end();
  return messages;
};

/**
 * Reads the harness's messages until its `result`. Returns undefined when the
 * harness ended without one. Rejects when the harness fails to run, for
 * example when the binary cannot start.
 */
const readQueryResult = async (
  messages: AsyncIterable<SDKMessage>,
): Promise<Extract<SDKMessage, { type: "result" }> | undefined> => {
  for await (const message of messages) {
    if (message.type === "result") return message;
  }
  return undefined;
};

/**
 * Returns the plugins for a session:
 *
 * - Hercule's own plugin, which gives the agent Hercule as a tool (spec 06
 *   section 9.3). The runner writes it into a directory at startup.
 * - the library skills folder, when its start named skills from the Skill
 *   Library (spec 06 section 9.4). The runner builds it as a plugin named
 *   `skills` for each start.
 *
 * - the repository skills folders, one plugin per checkout that has skills
 *   (`ctx.repositorySkillsFolders`). Each is named `repo-<checkout>`, so its
 *   skills are `repo-<checkout>:<name>` and never clash with the `hercule`
 *   plugin, even in a repository called `hercule`.
 *
 * All are loaded by path, independently of `settingSources`, so they load
 * the same way whether or not the session has a workspace. The order is
 * Hercule's plugin, the library skills folder, then the repository folders in
 * the order given.
 */
const buildPlugins = (ctx: ProviderRunnerContext): NonNullable<Options["plugins"]> => [
  { type: "local", path: ctx.herculeTool.claudePluginDir },
  ...(ctx.librarySkillsFolder === undefined
    ? []
    : [{ type: "local" as const, path: ctx.librarySkillsFolder }]),
  ...(ctx.repositorySkillsFolders ?? []).map((path) => ({ type: "local" as const, path })),
];

/**
 * Returns the Claude settings that turn off every skill Claude would load
 * natively from `.claude/skills` in the working directory or in one of the
 * session's checkouts. The repository skills folders already carry those
 * skills, under their qualified names (`repo-<checkout>:<name>`). Without
 * this, a session lists each of them twice, once under its plain name. A
 * skill the runner skipped, for example one in a folder called `My_Skill`,
 * would also load natively, so the rule is every entry of the folder, not only
 * the staged ones.
 *
 * The checkouts are listed too because Claude does not stop at the working
 * directory. When a tool of the session reads or writes a file, Claude
 * looks at every directory between that file and the working directory, and
 * loads the `.claude/skills` it finds there (checked against the Claude Code
 * CLI, see claude-code.integration.test.ts). A workspace with several
 * checkouts has its working directory above them, so without the checkouts
 * the first read in `web/` would load `web/.claude/skills` natively. If that
 * folder is a link to the user's own skills, it would also load those
 * (the #369 leak). Only the `.claude/skills` of the working directory and of
 * each checkout are listed. A deeper one, for example
 * `web/packages/app/.claude/skills`, cannot be known before the session
 * reads there, and still loads natively (spec 06 section 9.4).
 *
 * A `skillOverrides` entry turns off only the skill with that exact name, so
 * the qualified plugin skills stay loaded. Claude keys a native skill by its
 * folder name, not by the `name` in its SKILL.md: the entry for a folder `foo`
 * holding `name: bar` is `foo`, and an entry `bar` does nothing. The result
 * is empty when the session loads no project source, or when the folders
 * have no skills.
 *
 * The names are read under the runner's limits for listing skill folders (see
 * `listNativeClaudeSkills` and `runBoundedListing`). Fails with a message
 * that refuses the start when the folders hold too many entries, the read is
 * slow, or the runner is busy: the overrides would be incomplete, and the
 * skills they miss would load natively. The message is the one the supervisor
 * hands to the user as it is, so it ends with "The Thread did not start."
 * like the runner's other start refusals.
 */
const buildNativeSkillOverrides = (
  directories: ReadonlyArray<string>,
  loadsProject: boolean,
): Effect.Effect<Settings, AdapterFailed> => {
  if (!loadsProject) return Effect.succeed({});
  return runBoundedListing(listNativeClaudeSkills(directories)).pipe(
    Effect.mapError(
      (reason) =>
        new AdapterFailed({
          message:
            `The runner could not turn off the skills Claude Code would load natively from \`.claude/skills\`: ${endSentence(reason)} The Thread did not start.`.slice(
              0,
              MAX_MESSAGE_LENGTH,
            ),
        }),
    ),
    Effect.map((names): Settings =>
      names.length === 0
        ? {}
        : { skillOverrides: Object.fromEntries(names.map((name) => [name, "off" as const])) },
    ),
  );
};

/**
 * The name of the settings file inside the session skills folder. It is not
 * `settings.json`, which Claude would read as a setting of the plugin when the
 * folder is also the library skills plugin.
 */
const SESSION_SETTINGS_FILE = "claude-settings.json";

/**
 * Returns the `settings` option of a session: its fixed settings plus the
 * overrides that turn off the skills Claude would load natively.
 *
 * The overrides name every skill folder of every checkout. They are bounded
 * (see `buildNativeSkillOverrides`) but can still be thousands of names.
 * Passed inline they become one command-line argument, which Linux limits to
 * 128 KiB, and which fails the start with no message when it is too long. (On
 * macOS an argument that long does not fail, but the CLI then ignores the
 * overrides.) So when there are overrides, they are written to a file in the
 * session skills folder and the option is the file's path, which Claude reads
 * in full. The runner removes the file with the folder when the session
 * exits. Without overrides the settings stay inline, because they are small
 * and need no file. Fails with the reason when the names to turn off cannot
 * be read within the limits, or when the file cannot be written.
 */
const buildSessionSettings = (
  ctx: ProviderRunnerContext,
  loadsProject: boolean,
): Effect.Effect<string | Settings, AdapterFailed> =>
  Effect.flatMap(
    buildNativeSkillOverrides(
      [...(ctx.cwd === null ? [] : [ctx.cwd]), ...(ctx.checkoutPaths ?? [])],
      loadsProject,
    ),
    (overrides) =>
      Effect.tryPromise({
        try: async () => {
          const settings: Settings = { ...SESSION_SETTINGS, ...overrides };
          // A session whose project source is loaded has a workspace, so it has a
          // session skills folder. Without one there is nowhere to put the file.
          if (overrides.skillOverrides === undefined || ctx.sessionSkillsFolder === undefined) {
            return settings;
          }
          await mkdir(ctx.sessionSkillsFolder, { recursive: true });
          const path = join(ctx.sessionSkillsFolder, SESSION_SETTINGS_FILE);
          await writeFile(path, JSON.stringify(settings));
          return path;
        },
        catch: (error) =>
          new AdapterFailed({
            message: truncateMessage(
              endSentence(
                `The runner could not write the settings file for ${CLAUDE_CODE_NAME}: ${describeError(error)}`,
              ),
            ),
          }),
      }),
  );

/**
 * Returns the slash command that runs a skill in Claude: `/skills:<name>` for
 * a library skill and `/repo-<checkout>:<name>` for a repository skill. These
 * are the names `buildPlugins` gives the skills' plugins.
 */
const buildSkillCommandName = (skill: ResolvedSkillReference): string =>
  skill.source === "library"
    ? `/skills:${skill.skillName}`
    : `/repo-${skill.checkoutName}:${skill.skillName}`;

/** The text of an input as Claude gets it, in the two parts `buildClaudePromptParts` builds. */
interface ClaudePromptParts {
  /**
   * Everything before the command: the sender header, the text before the
   * command, and the line naming each image's file. Empty when there is none.
   */
  readonly leading: string;
  /** The slash command that runs the last skill, with the text after it. Absent without skills. */
  readonly command: string | undefined;
}

/**
 * Returns the text of an input split the way Claude needs it for the Skill
 * References of the text (spec 06 section 9.4, "Composer rules"). Claude runs
 * a slash command only when it is the start of the last text part of the
 * message, so an input with skills has two parts:
 *
 * - `command` is the Claude name of the last skill, then a space and the text
 *   after the reference without its leading whitespace. There is no space
 *   when that text is empty.
 * - `leading` is what `buildHarnessPrompt` builds around the text before that
 *   reference. Every earlier reference in it is replaced by its Claude name,
 *   which Claude runs only if the model chooses to call that skill.
 *
 * An input without skills has only `leading`, which is `buildHarnessPrompt`
 * unchanged.
 */
export const buildClaudePromptParts = (turn: AdapterTurnInput): ClaudePromptParts => {
  const references = turn.skillReferences ?? [];
  const last = references.at(-1);
  if (last === undefined) return { leading: buildHarnessPrompt(turn), command: undefined };
  let before = "";
  let at = 0;
  for (const reference of references.slice(0, -1)) {
    before += turn.text.slice(at, reference.start) + buildSkillCommandName(reference);
    at = reference.end;
  }
  before += turn.text.slice(at, last.start);
  const rest = turn.text.slice(last.end).trimStart();
  const name = buildSkillCommandName(last);
  return {
    // The space before the command is not part of the leading text.
    leading: buildHarnessPrompt(turn, before.trimEnd()),
    // Claude ends the command name at the first whitespace, so the space is
    // needed even when the text after the reference starts with punctuation:
    // `$review: now` must become `/skills:review : now`, because
    // `/skills:review: now` would name the unknown command `skills:review:`.
    command: rest === "" ? name : `${name} ${rest}`,
  };
};

/**
 * Returns the content of the user message an input becomes. Its text is the
 * prompt `buildClaudePromptParts` builds. Without images and without a skill
 * command, the content is the leading text as a plain string. With images, it
 * is the leading text block, then one base64 image block per image in order,
 * and the command block last, because Claude runs a command only from the last
 * text block. The leading block is left out when it is empty. Claude shrinks a
 * large image itself. The images are read one at a time, so an input with many
 * images does not read all its files at once. Fails with a message naming the
 * image when a cached file cannot be read.
 */
const buildUserContent = (
  turn: AdapterTurnInput,
): Effect.Effect<SDKUserMessage["message"]["content"], AdapterFailed> => {
  const attachments = turn.attachments ?? [];
  const { leading, command } = buildClaudePromptParts(turn);
  const buildTextBlock = (text: string) => ({ type: "text" as const, text });
  if (attachments.length === 0) {
    if (command === undefined) return Effect.succeed(leading);
    return Effect.succeed(
      leading === "" ? command : [buildTextBlock(leading), buildTextBlock(command)],
    );
  }
  const readImages = Effect.forEach(attachments, readAttachmentBase64).pipe(
    Effect.mapError((message) => new AdapterFailed({ message })),
  );
  return Effect.map(readImages, (images) => [
    ...(leading === "" ? [] : [buildTextBlock(leading)]),
    ...images.map((data, at) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: attachments[at]!.mimeType, data },
    })),
    ...(command === undefined ? [] : [buildTextBlock(command)]),
  ]);
};

/**
 * The Claude tools in each tool family. The spec talks about tool families,
 * and this table is the only place a family is converted to tool names. A
 * family whose tools Claude does not have maps to an empty list.
 */
const CLAUDE_TOOLS_BY_FAMILY: Readonly<Record<DisallowedTool, ReadonlyArray<string>>> = {
  edit: ["Edit", "NotebookEdit"],
  write: ["Write"],
  shell: ["Bash"],
  "web-search": ["WebSearch"],
  "web-fetch": ["WebFetch"],
};

/**
 * The Claude tools no session gets, whatever its spec says. `SendFile` sends
 * files to another Claude session, and to nothing else, while a session
 * reaches other sessions through Hercule only.
 *
 * `ListAgents` stays: it only reads, and an agent that reuses its subagents
 * needs it to find their names again after its context was compacted. The
 * other sessions it also lists cannot be reached, because the `SendMessage`
 * hook refuses any message that leaves the session.
 */
const ALWAYS_DISALLOWED_TOOLS: ReadonlyArray<string> = ["SendFile"];

/**
 * The Claude settings every session runs with. Each one turns off a way for a
 * Claude session to talk to other Claude sessions outside Hercule:
 *
 * - `disableAgentView` turns off background sessions and the daemon that hosts them;
 * - `disableRemoteControl` keeps the session from being driven from claude.ai,
 *   even when the user's own settings, which a Thread loads, turn it on;
 * - `crossSessionInbound: "refuse"` refuses messages from the user's other
 *   Claude sessions.
 *
 * A setting passed here takes precedence over the user's and the project's
 * settings files.
 */
const SESSION_SETTINGS: Settings = {
  disableAgentView: true,
  disableRemoteControl: true,
  crossSessionInbound: "refuse",
};

/**
 * The reason the model is given when it sends a message to anything but one of
 * its own subagents.
 */
const MESSAGE_TO_OTHER_SESSION_REFUSED =
  "SendMessage reaches only this session's own agents: the subagents it started, " +
  'and "main" from a subagent. ' +
  "To work with another session, use Hercule: `hercule session spawn` starts one, " +
  "and `hercule session input` sends a message to one that exists.";

/**
 * Returns the SDK options for a session. Unlike a probe, a session runs the
 * user's work, so it gets the workspace as its working directory. Its config
 * directory is always the instance's home, which every session of the
 * instance shares. The setting sources it loads depend on the session:
 *
 * - A Thread that sees User Material loads the user source, which the CLI
 *   reads from its config directory. The runner links the user's own agents,
 *   commands, rules and `CLAUDE.md` into the instance's home, so this is how
 *   the Thread finds them (spec 06 section 9.1). A Thread's skills are not
 *   among them: they come from its library skills folder, a plugin
 *   (`buildPlugins`). Every other session leaves the user source out, so an
 *   assistant session or a workflow step never reads those links, even though
 *   it shares the home.
 * - A session with a workspace also loads the project source, because the
 *   repository's instructions are part of the work. The CLI then reads
 *   `CLAUDE.md`, `.claude/CLAUDE.md` and `.claude/rules/` in the workspace
 *   and in every directory above it. Workspaces sit under the Hercule Home,
 *   usually in the user's home directory, so this includes
 *   `~/.claude/CLAUDE.md`. That is accepted.
 * - Any other session without a workspace runs in an empty scratch directory
 *   and loads no setting source at all, so no stray file on this runner can
 *   reach it.
 *
 * MCP servers come only from the options, and auto memory is off, for every
 * session. So is every way of messaging another Claude session: a session
 * reaches other sessions through Hercule only. Its own subagents stay
 * reachable (spec 06 section 9.1).
 */
const buildSessionOptions = (
  ctx: ProviderRunnerContext,
  spec: SessionSpec,
  binary: string,
  native: Options,
  canUseTool: CanUseTool,
  refuseMessageToOtherSession: HookCallback,
  settings: string | Settings,
): Options => {
  const effort = readEffort(spec.modelSelection.options);
  const disallowedTools = [
    ...(spec.disallowedTools ?? []).flatMap((family) => CLAUDE_TOOLS_BY_FAMILY[family]),
    ...ALWAYS_DISALLOWED_TOOLS,
  ];
  // The Hercule skill is not part of this text: the CLI loads it as a plugin
  // (`plugins` below). So the coordination paragraph and an assistant's memory,
  // which come after the skill on every harness, are simply appended last.
  const instructions = joinInstructions([
    ctx.herculeTool.orientation,
    spec.systemPrompt,
    spec.coordination,
    spec.memory,
  ]);
  return {
    pathToClaudeCodeExecutable: binary,
    ...native,
    // These two fields are set only when there is something to set. A preset
    // with nothing appended would add a setting nobody asked for.
    ...(instructions === undefined
      ? {}
      : { systemPrompt: { type: "preset", preset: "claude_code", append: instructions } }),
    disallowedTools,
    ...(spec.outputSchema === undefined
      ? {}
      : { outputFormat: { type: "json_schema", schema: spec.outputSchema } }),
    ...(ctx.cwd === null ? {} : { cwd: ctx.cwd }),
    // The agent's prompt names the file of each attached image, and the
    // directory is outside the workspace, so the harness is told it may read
    // there. Without this, a session that is not in `full-access` asks the
    // user before it reads its own images.
    ...(ctx.attachmentsDir === null ? {} : { additionalDirectories: [ctx.attachmentsDir] }),
    // A skill, library or repository, may tell the agent to read the other
    // files of its folder. A library skill's folder is inside the session
    // skills folder, and a repository skill's folder is linked into it, so
    // the same rule covers both. The folder is outside the workspace, and
    // this rule lets the agent read there without asking the user. It allows
    // nothing else: unlike `additionalDirectories`, it does not let an
    // `acceptEdits` session write there unasked. The leading `/` of the path
    // makes the rule's `//`, which marks an absolute path.
    //
    // Claude matches the rule against the resolved path of the file, not
    // against the path the agent typed. A read through a link that leads out
    // of the session skills folder is therefore not covered by the rule: it
    // goes to `canUseTool` and asks the user, and nothing is read unasked.
    // Checked on the real CLI with a repository skill whose `refs` link
    // pointed outside the checkout. A plain file inside the folder is read
    // without asking.
    //
    // The rule matters for library skills. The files of a repository skill
    // are also inside the checkouts, which are in the session's working
    // directory, so Claude can read them without this rule.
    ...(ctx.sessionSkillsFolder === undefined
      ? {}
      : { allowedTools: [`Read(/${ctx.sessionSkillsFolder}/**)`] }),
    settingSources: [
      ...(ctx.userMaterial === undefined ? [] : (["user"] as const)),
      ...(spec.workspaceId === null ? [] : (["project"] as const)),
    ],
    settings,
    // A hook, unlike `canUseTool`, runs for every tool call in every access
    // mode, `full-access` included. So no session can message another Claude
    // session, and every tool that can write files is marked.
    hooks: {
      PreToolUse: [
        { matcher: "SendMessage", hooks: [refuseMessageToOtherSession] },
        ...(ctx.editMarks === null
          ? []
          : [{ matcher: FILE_WRITING_TOOL_MATCHER, hooks: [buildStartMarkHook(ctx.editMarks)] }]),
      ],
    },
    strictMcpConfig: true,
    includePartialMessages: true,
    // Without this, the SDK sends only a subagent's tool calls and results,
    // and none of its text, so a subagent's transcript would have no words in
    // it (spec 06 section 13.6).
    forwardSubagentText: true,
    // `perTaskStopAffordance` stays unset, so `interrupt()` also stops
    // background subagents (spec 06 section 13.4).
    model: spec.modelSelection.model,
    ...(effort === undefined ? {} : { effort }),
    permissionMode: PERMISSION_MODES[spec.accessMode],
    // The callback is passed in every mode. The harness leaves out the
    // `AskUserQuestion` tool when it has no callback. In `bypassPermissions`
    // it still calls the callback for a question and for a call that always
    // needs the user's approval. The SDK warns that the callback "will not be
    // invoked" in that mode; the warning does not hold for those calls.
    canUseTool,
    ...(spec.accessMode === "full-access" ? { allowDangerouslySkipPermissions: true } : {}),
    env: {
      ...buildEnv(ctx),
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      // An assistant's session is rotated by the controller instead of being
      // compacted by the CLI (spec 06 section 9.2). `DISABLE_AUTO_COMPACT`
      // turns off only the automatic compaction. `DISABLE_COMPACT` would also
      // turn off `/compact`, which the user can still send as a message.
      ...(spec.autoCompaction === false ? { DISABLE_AUTO_COMPACT: "1" } : {}),
    },
    plugins: buildPlugins(ctx),
  };
};

/**
 * Returns the native session id a start uses, and the SDK options that select
 * it. A resume continues the parent's own session under its existing id. A fork
 * or a fresh start gets an id that Hercule creates rather than the harness: in
 * streaming-input mode the CLI sends nothing, not even `init`, until the first
 * turn arrives, so waiting for its id would block `startSession` until someone
 * sent input.
 */
const resolveNativeSession = (
  spec: SessionSpec,
): { readonly nativeSessionId: string; readonly options: Options } => {
  const carried = spec.continue;
  if (carried?.mode === "resume") {
    return {
      nativeSessionId: carried.nativeSessionId,
      options: { resume: carried.nativeSessionId },
    };
  }
  const nativeSessionId = crypto.randomUUID();
  return {
    nativeSessionId,
    options: {
      sessionId: nativeSessionId,
      ...(carried === undefined ? {} : { resume: carried.nativeSessionId, forkSession: true }),
    },
  };
};

/** One session this adapter is hosting. */
interface Live {
  readonly binding: SessionBinding;
  readonly input: Pushable<SDKUserMessage>;
  readonly stream: ClaudeStream;
  readonly state: Normalizing;
  /** Uploads the images in the session's tool results, so its events carry only references. */
  readonly attachmentUploader: AttachmentUploader;
  /** How the session reports to the edit watch, or `null` when its edits are not observed. */
  readonly editMarks: EditMarks | null;
  /** The item id of the Bash call that started each shell, by task id (`trackShellProcess`). */
  readonly shellItems: Map<string, string>;
  /** Aborted by `stopSession`, so a stop does not wait for the images still uploading. */
  readonly uploads: AbortController;
  /**
   * The requests this session is waiting on, by request id: one for each
   * `canUseTool` call still open, from the session's own agent or a subagent.
   * The parks are stored on the session entry, not in a separate map, because
   * each is a promise inside the harness's own call, so they must go away with
   * the session that waits on them.
   */
  readonly parks: Parks;
  /** Set by `stopSession` to its reason, so the `session.exited` event can report it. */
  stopping: ExitReason | undefined;
  /** The model the harness is using. It starts as the model in the session spec. */
  model: string;
  /** Counts Stops so an input waiting for a model change cannot continue after its Stop. */
  inputGeneration: number;
}

export const makeClaudeCodeAdapter = (seam: ClaudeSeam): ProviderAdapter => {
  // Creating an unbounded PubSub only allocates memory, so it is safe to run
  // synchronously here. That keeps `findAdapter` a synchronous lookup, which is
  // how every caller already uses it.
  const published = Effect.runSync(PubSub.unbounded<ProviderEvent>());
  const live = new Map<string, Live>();

  const emit = (event: ProviderEvent): void => {
    PubSub.publishUnsafe(published, event);
  };

  /**
   * Sends one control request with a time limit. Returns why it failed, or
   * `undefined` when it succeeded. Never fails itself.
   */
  const sendControlRequest = (request: Promise<void>): Effect.Effect<string | undefined> =>
    Effect.map(
      Effect.timeoutOption(
        Effect.match(Effect.tryPromise({ try: () => request, catch: describeError }), {
          onFailure: (why: string) => why,
          onSuccess: () => undefined,
        }),
        CONTROL_DEADLINE,
      ),
      Option.getOrElse(
        () => `the harness did not answer within ${Duration.format(CONTROL_DEADLINE)}`,
      ),
    );

  /**
   * Returns the `PreToolUse` hook for `SendMessage`. The hook lets a message
   * through when it stays inside the session: a message to one of the
   * session's own subagents, or one from a subagent to `"main"`, the
   * session's own agent. It refuses any other message, with a reason the model
   * reads. `SendMessage` also reaches the user's other Claude sessions, and
   * such a message bypasses Hercule: nothing records it, and no screen shows
   * it. A message from a session that is no longer hosted here is refused too.
   *
   * The hook keeps the model on Hercule's path. It is not a sandbox: another
   * `PreToolUse` hook from the project's settings may rewrite the input after
   * this one allowed it, and a session with a shell can reach the user's
   * other sessions without any tool. Neither is the model using `SendMessage`
   * by mistake, which is what this hook is for.
   */
  const buildRefuseMessageToOtherSession =
    (sessionId: string): HookCallback =>
    (input) => {
      const held = live.get(sessionId);
      const withinSession =
        held !== undefined &&
        input.hook_event_name === "PreToolUse" &&
        isMessageWithinSession(held.state.subagents, input.agent_id, input.tool_input);
      return Promise.resolve(
        withinSession
          ? {}
          : {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: MESSAGE_TO_OTHER_SESSION_REFUSED,
              },
            },
      );
    };

  /**
   * Builds the `canUseTool` callback the harness calls to ask for approval
   * or to ask a question (spec 06 section 8.2). In `full-access` it opens no
   * approval: it refuses every call but a question at once. The promise the
   * callback returns is the park. It stays open until one of these happens:
   *
   * - the user answers;
   * - the harness withdraws the request by aborting the signal;
   * - the turn is interrupted or the session ends;
   * - the turn of the subagent that asked ends;
   * - the subagent that asked, or one above it, is stopped;
   * - frames of the subagent that asked are dropped, so its turn may never
   *   open.
   *
   * Each call gets its own park, under a request id the adapter creates, and
   * every answer comes back with that request id. Several parks can be open at
   * once: the session's own agent and each subagent may ask at the same time
   * (spec 06 section 13.3).
   */
  const buildCanUseTool =
    (sessionId: string, accessMode: AccessMode): CanUseTool =>
    (toolName, input, options) => {
      if (accessMode === "full-access" && toolName !== ASK_USER_QUESTION) {
        return Promise.resolve({ behavior: "deny", message: FULL_ACCESS_NOT_ASKED });
      }
      const held = live.get(sessionId);
      // Deny by default, using the same check that rejects input: when the
      // session is gone or stopping, nobody is left to answer, and the park
      // would hold the harness for ever.
      if (held === undefined || held.stopping !== undefined) {
        return Promise.resolve(buildDenyResult());
      }
      // Already withdrawn before it was shown: the turn is being
      // interrupted, so there is nothing to show the user.
      if (options.signal.aborted) return Promise.resolve(buildDenyResult());
      // The SDK sets `agentID` only for a call from inside a subagent. An
      // empty one is read as the session's own agent, because the protocol
      // does not accept an empty id.
      const subagentId = cleanSubagentId(options.agentID);
      const subagent =
        subagentId === undefined ? undefined : held.state.subagents.byId.get(subagentId);
      // The request would wait for ever for a turn to be shown in, in two
      // cases:
      //
      // - a stopped Claude subagent runs no more turns;
      // - the frames that would open the subagent's turn were dropped. Denied,
      //   the subagent goes on, and its next frame opens its turn.
      if (subagent?.stop === "stopped" || subagent?.openingFramesLost === true) {
        return Promise.resolve(buildDenyResult());
      }
      // A park belongs to its asker's turn: the turn is waiting on it, and the
      // supervisor pauses an open turn's inactivity timer while it waits. The
      // SDK can ask before the assistant message that starts the turn of the
      // session's own agent has been read from its stream, so open that turn
      // here if none is open yet. A subagent's park never opens it: the
      // session's own agent is not working just because a subagent asks
      // (spec 06 section 13.6).
      if (subagentId === undefined) {
        for (const event of openTurn(held.state).events) emit(event);
      }
      const persists = redirectRulesToSession(options.suggestions);
      const request = buildToolCallRequest(
        held.state.mint(),
        options.toolUseID,
        toolName,
        input,
        persists.length > 0,
      );
      // A `cancel` from a subagent's request ends only that subagent's turn:
      // the harness interrupts the agent that asked (spec 06 section 8.1).
      const { result, opened } = openPark(held.parks, held.state, emit, {
        request,
        subagentId,
        input,
        persists,
        signal: options.signal,
      });
      if (subagentId === undefined) {
        publishRequestOpened(held, opened);
        return result;
      }
      // `canUseTool` can run before the pump has read the subagent's assistant
      // frame that opens its turn. On the wire that frame always comes first,
      // so the request waits only for its own turn's opening events.
      for (const event of deferUntilTurnOpens(held.state.subagents, subagentId, opened)) {
        publishRequestOpened(held, event);
      }
      return result;
    };

  /**
   * Publishes a `request.opened` and marks its park reported, so the park's
   * end is published too. Skips the event when its park has already ended:
   * the request was never shown, so neither its start nor its end is
   * reported.
   */
  const publishRequestOpened = (held: Live, opened: RequestOpened): void => {
    const park = held.parks.get(opened.request.requestId);
    if (park === undefined) return;
    park.reported = true;
    emit(opened);
  };

  /**
   * Stops one subagent with `stopTask`. Never fails. When the harness refuses
   * or does not answer:
   *
   * - the subagent is reported with a `runtime.warning`, because the user
   *   asked to stop it and should know it may still run;
   * - the subagent is no longer marked as being stopped, so the user's next
   *   Stop sends `stopTask` again. Nothing sends it again by itself, so a
   *   harness that keeps refusing is not asked at every message.
   */
  const stopSubagent = (held: Live, subagentId: SubagentId): Effect.Effect<void> =>
    Effect.map(sendControlRequest(held.stream.stopTask(subagentId)), (refused) => {
      // Once the session stops, the harness is going away and every subagent
      // with it, so a refusal is no news to the user.
      const sessionStopped =
        held.stopping !== undefined || live.get(held.binding.sessionId) !== held;
      if (refused === undefined || sessionStopped) return;
      clearRefusedStop(held.state.subagents, subagentId);
      emit({
        _tag: "runtime.warning",
        eventId: held.state.mint(),
        sessionId: held.binding.sessionId,
        at: held.state.now(),
        subagentId,
        message: `the subagent was not stopped: ${refused}`,
      });
    });

  /**
   * Stops a subagent and every subagent below it (spec 06 section 13.4).
   * Claude Code does not stop a background child when its parent stops, so
   * each one is stopped here:
   *
   * - their open Requests end as cancelled;
   * - a working one gets `stopTask`, unless it already got one;
   * - an idle one has nothing to stop yet, so it gets `stopTask` as soon as it
   *   works again. A subagent one of them starts later is stopped the same way.
   *
   * Does nothing once the session is stopping, since every subagent stops with
   * it. An id this process does not know gets a `runtime.warning`. Never fails.
   */
  const stopSubagentTree = (held: Live, subagentId: SubagentId): Effect.Effect<void> => {
    if (held.stopping !== undefined) return Effect.void;
    const { subagents } = held.state;
    if (!subagents.byId.has(subagentId)) {
      emit({
        _tag: "runtime.warning",
        eventId: held.state.mint(),
        sessionId: held.binding.sessionId,
        at: held.state.now(),
        message: truncateMessage(
          `subagent ${subagentId} is not known to this process, so nothing was stopped`,
        ),
      });
      return Effect.void;
    }
    const targets = [subagentId, ...collectDescendants(subagents, subagentId)];
    // End the parks before stopping, as the session-wide interrupt does, so no
    // card stays open for a turn that is over.
    withdrawParksAskedBy(held.parks, new Set(targets));
    markStopsWanted(subagents, targets);
    return Effect.forEach(takeStopsDue(subagents), (target) => stopSubagent(held, target), {
      concurrency: "unbounded",
      discard: true,
    });
  };

  /**
   * Publishes the events of one harness message, in order. A subagent's
   * `turn.completed` first ends the Requests that subagent asked, as
   * cancelled, because a Request closes when its agent's turn ends, and its
   * end must be reported before the turn's.
   */
  const publishMessageEvents = (held: Live, events: ReadonlyArray<ProviderEvent>): void => {
    for (const event of events) {
      if (event._tag === "turn.completed" && event.subagentId !== undefined) {
        withdrawParksAskedBy(held.parks, new Set([event.subagentId]));
      }
      if (event._tag === "request.opened") publishRequestOpened(held, event);
      else emit(event);
    }
  };

  /**
   * Sends `stopTask` to each subagent whose stop is wanted and that works
   * again, and first ends the Requests those subagents asked, as cancelled.
   * Does not wait for the harness to answer: the pump must keep reading its
   * messages meanwhile.
   */
  const sendDueStops = (held: Live): void => {
    const due = takeStopsDue(held.state.subagents);
    if (due.length === 0) return;
    withdrawParksAskedBy(held.parks, new Set(due));
    void Effect.runPromise(
      Effect.forEach(due, (target) => stopSubagent(held, target), {
        concurrency: "unbounded",
        discard: true,
      }),
    );
  };

  /**
   * Withdraws each park whose `request.opened` the normalizer dropped because
   * it dropped frames of the subagent that asked. The subagent's turn may
   * never open, so the request would never be shown, and it ends with no
   * `request.resolved`. A park whose request was reported, or still waits
   * for its turn, stays open.
   */
  const withdrawRequestsOfDroppedSubagents = (held: Live): void => {
    const { waitingRequests } = held.state.subagents;
    for (const park of [...held.parks.values()]) {
      if (park.reported || park.subagentId === undefined) continue;
      if (!waitingRequests.has(park.subagentId)) park.withdraw();
    }
  };

  /** Returns the hosted session. Fails when there is none, or when it is stopping. */
  const getHostedSession = (sessionId: string): Effect.Effect<Live, SessionNotRunning> =>
    Effect.suspend(() => {
      const held = live.get(sessionId);
      if (held === undefined) return Effect.fail(buildSessionNotRunning());
      return held.stopping === undefined
        ? Effect.succeed(held)
        : Effect.fail(buildSessionStopping());
    });

  /**
   * Reads the harness's messages until its stream ends, and emits their events.
   * Then emits `session.exited` with the reason. Never rejects.
   */
  const pumpEvents = async (sessionId: string, held: Live): Promise<void> => {
    let reason: ExitReason = "process_exit";
    try {
      for await (const sdk of held.stream) {
        // Awaited one message at a time, so the events keep the harness's order.
        const withReferences = await Effect.runPromise(
          replaceToolResultImages(held.attachmentUploader, sessionId, sdk, held.uploads.signal),
        );
        if (held.editMarks !== null) trackShellProcess(held.editMarks, held.shellItems, sdk);
        publishMessageEvents(held, normalize(held.state, withReferences));
        sendDueStops(held);
        withdrawRequestsOfDroppedSubagents(held);
      }
    } catch (error) {
      reason = "crash";
      // Ending the query rejects whatever was in progress, and a normal stop
      // should not be reported as a runtime error.
      if (held.stopping === undefined) {
        emit({
          _tag: "runtime.error",
          eventId: held.state.mint(),
          sessionId,
          at: held.state.now(),
          class: "unknown",
          message: describeError(error),
        });
      }
    } finally {
      // Every exit passes through here, so end the parks here, before the
      // exit is reported. A park left open is a promise the harness waits on
      // for ever, and it leaves an approval card on a session that is gone,
      // which nobody can answer.
      withdrawAllParks(held.parks);
      // Compare by identity: a session started again under the same id has a
      // new entry, and that entry belongs to a different pump.
      if (live.get(sessionId) === held) live.delete(sessionId);
      emit({
        _tag: "session.exited",
        eventId: held.state.mint(),
        sessionId,
        at: held.state.now(),
        reason: held.stopping ?? reason,
      });
    }
  };

  const readVersion = (ctx: ProviderRunnerContext, binary: string): Effect.Effect<string | null> =>
    Effect.map(seam.run([binary, "--version"], buildEnv(ctx)), (ran) => {
      if (ran.code !== 0) return null;
      // Report an unrecognised version as printed. The protocol does not
      // accept an empty one, so that becomes null.
      const printed = truncateFact(SEMVER.exec(ran.stdout)?.[0] ?? ran.stdout.trim());
      return printed === "" ? null : printed;
    });

  const queryHarness = (
    ctx: ProviderRunnerContext,
    binary: string,
  ): Effect.Effect<{ account: Account; models: ReadonlyArray<Model> }, string> =>
    Effect.acquireUseRelease(
      Effect.sync(() => seam.query({ options: buildProbeOptions(ctx, binary) })),
      (session) =>
        Effect.gen(function* () {
          const account = yield* Effect.tryPromise({
            try: () => session.accountInfo(),
            catch: describeError,
          });
          const models = yield* Effect.tryPromise({
            try: () => session.supportedModels(),
            catch: describeError,
          });
          return { account: account as Account, models: models as ReadonlyArray<Model> };
        }),
      (session) => Effect.sync(() => session.close()),
    );

  return {
    providerId: CLAUDE_CODE,
    binaryName: CLAUDE_BINARY,

    events: Stream.fromPubSub(published),

    startSession: (
      sessionId: string,
      spec: SessionSpec,
      ctx: ProviderRunnerContext,
    ): Effect.Effect<SessionBinding, AdapterError> =>
      Effect.suspend((): Effect.Effect<SessionBinding, AdapterError> => {
        const binary = ctx.binary;
        if (binary === undefined) {
          return Effect.fail(buildHarnessNotInstalled(CLAUDE_CODE_NAME));
        }
        const native = resolveNativeSession(spec);
        const binding: SessionBinding = {
          sessionId,
          nativeSessionId: native.nativeSessionId,
          instanceId: spec.instanceId,
        };
        const input = createPushable<SDKUserMessage>();
        return Effect.map(
          Effect.flatMap(buildSessionSettings(ctx, spec.workspaceId !== null), (settings) =>
            Effect.suspend((): Effect.Effect<ClaudeStream, AdapterError> => {
              // Checked after the settings file is written, which waits: the
              // check and `live.set` below must follow each other with no
              // wait between them. Two harnesses under one Hercule session id
              // would mix up their events and their exits, so the second
              // start fails.
              if (live.has(sessionId)) {
                return Effect.fail(buildSessionAlreadyRunning());
              }
              return Effect.try({
                try: () =>
                  seam.stream({
                    options: buildSessionOptions(
                      ctx,
                      spec,
                      binary,
                      native.options,
                      buildCanUseTool(sessionId, spec.accessMode),
                      buildRefuseMessageToOtherSession(sessionId),
                      settings,
                    ),
                    input,
                  }),
                catch: (error) => buildHarnessStartFailed(CLAUDE_CODE_NAME, describeError(error)),
              });
            }),
          ),
          (stream) => {
            const held: Live = {
              binding,
              input,
              stream,
              state: buildNormalizingState(
                sessionId,
                () => crypto.randomUUID(),
                now,
                spec.outputSchema,
                spec.continue?.subagents,
              ),
              attachmentUploader: ctx.attachmentUploader,
              editMarks: ctx.editMarks,
              shellItems: new Map(),
              uploads: new AbortController(),
              parks: new Map(),
              stopping: undefined,
              inputGeneration: 0,
              model: spec.modelSelection.model,
            };
            live.set(sessionId, held);
            void pumpEvents(sessionId, held);
            // The event carries the native id because the controller has no
            // other way to learn it: `sessionsReport` is sent only once, at
            // hello, so it never includes a session started after that.
            emit({
              _tag: "session.started",
              eventId: held.state.mint(),
              sessionId,
              at: held.state.now(),
              providerRefs: { nativeSessionId: binding.nativeSessionId },
            });
            return binding;
          },
        );
      }),

    sendInput: (
      sessionId: string,
      turn: AdapterTurnInput,
    ): Effect.Effect<SendResult, AdapterError> =>
      Effect.gen(function* () {
        // Read before anything changes: an image that cannot be read refuses
        // the input before a turn opens.
        const content = yield* buildUserContent(turn);
        const model = turn.modelSelection?.model;
        const before = yield* getHostedSession(sessionId);
        const generation = before.inputGeneration;
        // Change the model only when a new turn is about to open: during a
        // turn, the harness keeps the model the turn started with. Only ask
        // when the model differs from the one last applied, so a session with
        // nothing to change never waits on the harness. If the harness rejects
        // the model, the input fails: sending it under the old model would run
        // a turn the caller did not ask for.
        if (model !== undefined && model !== before.model && before.state.turnId === undefined) {
          const refused = yield* sendControlRequest(before.stream.setModel(model));
          if (refused !== undefined) {
            return yield* Effect.fail(
              buildModelChangeRefused(CLAUDE_CODE_NAME, `switch to the model ${model}`, refused),
            );
          }
          before.model = model;
        }
        // Look the session up again: `setModel` waits on the harness, and in
        // the meantime a turn may have opened or ended, or the session may have
        // stopped.
        const held = yield* getHostedSession(sessionId);
        if (held !== before || held.inputGeneration !== generation)
          return yield* Effect.fail(buildInputStopped());
        // Claude does not run a slash command pushed into a running turn: it
        // holds the message and runs it as the next turn, so the skill would
        // start late and the user would see a steer that did not steer.
        // Refuse before opening anything, so the input stays queued and runs
        // normally when this turn ends.
        if (
          held.state.turnId !== undefined &&
          turn.skillReferences !== undefined &&
          turn.skillReferences.length > 0
        ) {
          return yield* Effect.fail(
            new SteerRefused({ message: buildSkillSteerRefusedMessage("Claude") }),
          );
        }
        const { turnId, events } = openTurn(held.state);
        for (const event of events) emit(event);
        // Steering is implicit: if `openTurn` did not open a new turn, a turn
        // is already running, and the input joins it. Decide from what
        // `openTurn` just did, not from what was true before the wait.
        const steered = events.length === 0;
        for (const event of buildUserMessage({
          sessionId,
          turnId,
          text: turn.text,
          steered,
          attachments: turn.attachments,
          skillReferences: turn.skillReferences,
          senderSessionId: turn.senderSessionId,
        })) {
          emit(event);
        }
        held.input.push({
          type: "user",
          message: { role: "user", content },
          parent_tool_use_id: null,
          session_id: held.binding.nativeSessionId,
        });
        return { turnId, delivery: steered ? "steered" : "opened" };
      }),

    interrupt: (sessionId: string, subagentId?: SubagentId): Effect.Effect<void> =>
      Effect.suspend(() => {
        const held = live.get(sessionId);
        if (held === undefined) return Effect.void;
        if (subagentId !== undefined) return stopSubagentTree(held, subagentId);
        held.inputGeneration += 1;
        // Nothing is running, so do not send the harness a control request: it
        // would wait on the harness and hold up the connection's other frames.
        // A background subagent can run, or ask, while the session's own agent
        // is idle, and the interrupt stops it too (spec 06 section 13.4).
        if (!isAnyAgentWorking(held.state) && held.parks.size === 0) return Effect.void;
        // End the parks before sending the interrupt, not after. The CLI
        // withdraws a pending request once the turn is interrupted, and a
        // request still open when the turn completes leaves a card on screen
        // for a turn that is over. The interrupt stops every subagent too, so
        // their parks end as well.
        withdrawAllParks(held.parks);
        // The turn completing as `interrupted` is the only report. If the
        // request fails, the harness is already gone, which has the same result.
        return Effect.asVoid(sendControlRequest(held.stream.interrupt()));
      }),

    stopSession: (sessionId: string, reason: ExitReason): Effect.Effect<void> =>
      Effect.sync(() => {
        const held = live.get(sessionId);
        // Stopping twice is harmless, and the first reason wins. A second stop
        // (a timer racing an explicit stop, for example) finds the harness
        // already stopping, and the exit should report the first reason.
        if (held === undefined || held.stopping !== undefined) return;
        // The entry stays in `live` until the pump finishes, so `live` remains
        // the single list of what this adapter hosts, and a new start under the
        // same id fails while the old harness is still running. Until then,
        // `stopping` makes input fail, and gives the exit event its reason.
        held.stopping = reason;
        // Do not end the parks here: closing the stream ends the pump, and the
        // pump's `finally` ends the parks on every exit.
        held.uploads.abort();
        held.input.end();
        void held.stream.close();
      }),

    respondToApprovalRequest: (
      sessionId: string,
      requestId: string,
      decision: ApprovalDecision,
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        const park = live.get(sessionId)?.parks.get(requestId);
        if (park?.kind !== "approval") return;
        // Ignore a decision the request did not offer: the harness would have
        // to replace it with something else.
        if (park.decisions.includes(decision)) park.decide(decision);
      }),

    respondToQuestion: (
      sessionId: string,
      requestId: string,
      answers: QuestionAnswers,
    ): Effect.Effect<void, AnswerNotDelivered> =>
      Effect.suspend(() => {
        const park = live.get(sessionId)?.parks.get(requestId);
        if (park?.kind !== "question") {
          return Effect.fail(
            new AnswerNotDelivered({
              message:
                "The question is no longer open: it was already answered, or the agent that asked it stopped.",
            }),
          );
        }
        park.answer(answers);
        return Effect.void;
      }),

    listSessions: Effect.sync(() => [...live.values()].map((held) => held.binding)),
    // The config is empty for every shipped provider, so it is not read.
    generateText: (ctx, _config, spec) =>
      // The harness is closed, and its exit awaited, before the runner
      // removes its working directory and frees the call's slot, so nothing is
      // still writing into the directory. The stream stops the CLI itself if
      // the SDK's own close leaves it running.
      Effect.acquireUseRelease(
        Effect.try({
          try: () =>
            seam.stream({
              options: buildTextGenerationOptions(ctx, spec),
              input: buildTextGenerationInput(spec.input),
              closeWaitsForExit: true,
            }),
          catch: describeError,
        }),
        (stream) =>
          Effect.map(
            Effect.tryPromise({ try: () => readQueryResult(stream), catch: describeError }),
            (result): TextGenerationOutcome =>
              result === undefined
                ? { outcome: "failed", message: "the harness ended without an answer" }
                : decideTextGenerationOutcome(spec.outputSchema, result),
          ),
        (stream) =>
          Effect.promise(async () => {
            await stream.close();
          }),
      ),

    // Every shipped provider's config schema is empty, so the Claude adapter
    // does not read the config and leaves out that parameter.
    probe: (ctx: ProviderRunnerContext): Effect.Effect<ProbeResult> => {
      const binary = ctx.binary;
      if (binary === undefined) {
        return Effect.succeed(buildFailedProbe(null, `no ${CLAUDE_BINARY} on this machine`));
      }
      const gather = Effect.gen(function* () {
        const harnessVersion = yield* readVersion(ctx, binary);
        return yield* Effect.match(queryHarness(ctx, binary), {
          onFailure: (message) => buildFailedProbe(harnessVersion, message),
          onSuccess: ({ account, models }) => ({
            harnessVersion,
            auth: buildAuth(account),
            models: buildCatalog(models),
          }),
        });
      });
      return Effect.map(
        Effect.timeoutOption(gather, PROBE_DEADLINE),
        Option.getOrElse(() =>
          buildFailedProbe(
            null,
            `the harness did not answer within ${Duration.format(PROBE_DEADLINE)}`,
          ),
        ),
      );
    },

    /**
     * Returns the login command. `BROWSER` is set to a command that fails on
     * purpose: if a browser opened, the CLI would switch to a `localhost`
     * callback, which a browser on another machine cannot reach.
     */
    login: (ctx: ProviderRunnerContext, binary: string): LoginCommand => ({
      command: [binary, "auth", "login"],
      env: { ...buildEnv(ctx), BROWSER: "false" },
    }),

    /**
     * Installs the CLI version this build's SDK expects. The install script
     * still needs network access.
     */
    install: makeInstall(seam.run, [
      "bash",
      "-c",
      `curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_CODE_VERSION}`,
    ]),
  };
};

export const claudeCode: ProviderAdapter = makeClaudeCodeAdapter({
  stream: ({ options, input, closeWaitsForExit }) => {
    // Only a text generation starts the CLI itself. A session keeps the SDK's
    // own start and its own way of stopping.
    const owner = closeWaitsForExit === true ? createChildOwner() : undefined;
    const running: Query = sdkQuery({
      prompt: input,
      options: owner === undefined ? options : { ...options, spawnClaudeCodeProcess: owner.spawn },
    });
    return {
      [Symbol.asyncIterator]: () => running[Symbol.asyncIterator](),
      interrupt: () => running.interrupt().then(() => undefined),
      setModel: (model) => running.setModel(model),
      stopTask: (taskId) => running.stopTask(taskId),
      close: async () => {
        // The child may already be gone, and an unhandled rejection would take
        // the whole daemon down just because one session ended.
        await running.return(undefined).then(
          () => undefined,
          () => undefined,
        );
        // The SDK stops waiting about 2 seconds after it asked the CLI to
        // exit, and the CLI can still be running then.
        if (owner !== undefined) await Effect.runPromise(owner.stop);
      },
    };
  },
  query: ({ options }) => {
    const session: Query = sdkQuery({ prompt: buildEmptyPrompt(), options });
    return {
      accountInfo: () => session.accountInfo(),
      supportedModels: () => session.supportedModels(),
      close: () => {
        // The child is usually already gone when close runs, and an unhandled
        // rejection would take the whole daemon down because of one bad probe.
        session.return(undefined).catch(() => undefined);
      },
    };
  },
  run: runProcess,
});
