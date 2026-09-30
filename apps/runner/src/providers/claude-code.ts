/**
 * The Claude Code provider adapter, and the only file that imports the vendor
 * SDK.
 *
 * The probe sends no prompt and uses the SDK's control requests instead,
 * because a real prompt would bill the user's account just for opening a Fleet
 * page. The adapter uses only the instance's own config directory, never the
 * user's `~/.claude`.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import {
  query as sdkQuery,
  type CanUseTool,
  type EffortLevel,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_CODE_VERSION } from "@hercule/home/version";
import {
  MAX_FACT_ITEMS,
  type AccessMode,
  type ApprovalDecision,
  type DisallowedTool,
  type ExitReason,
  type ModelDescriptor,
  type ModelOption,
  type OpenRequest,
  type ProbeResult,
  type ProviderEvent,
  type SendResult,
  type SessionBinding,
  type SessionSpec,
  type TurnInput,
} from "@hercule/protocol";
import {
  normalize,
  buildNormalizingState,
  openTurn,
  classifyTool,
  type Normalizing,
} from "./claude-code-normalize";
import type { ProviderAdapter, ProviderRunnerContext } from "./index";
import { makeInstall } from "./install";
import { PROBE_DEADLINE, buildFailedProbe } from "./probe";
import type { LoginCommand } from "./login";
import { runProcess, type Run } from "./process";
import { truncateFact, truncateMessage } from "./text";
import { buildUserMessage } from "./events";
import { buildQuestionRequest } from "./questions";
import { now } from "../report";

export const CLAUDE_CODE = "claude-code";

const CLAUDE_BINARY = "claude";

/**
 * How long a control request may take. A control request writes to the harness
 * child process and waits for its reply. The runner handles session frames one
 * at a time, in order, so without a time limit one child that stops responding
 * would hold up every session on the machine, pings included.
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
  /** Ends the query. The CLI is a child process, and it does not exit on its own. */
  readonly close: () => void;
}

export interface ClaudeSeam {
  readonly query: (params: { readonly options: Options }) => ClaudeSession;
  readonly stream: (params: {
    readonly options: Options;
    readonly input: AsyncIterable<SDKUserMessage>;
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
    options: [buildEffortOption(["low", "medium", "high"])],
  },
  {
    slug: "claude-fable-5",
    name: "Fable 5",
    isLegacy: true,
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
 * through `canUseTool`. The callback is passed in every mode except
 * `full-access`: the harness decides which actions a mode asks about, and a
 * mode that asks about nothing never calls it.
 */
const PERMISSION_MODES: Readonly<Record<AccessMode, PermissionMode>> = {
  "approval-required": "default",
  "auto-accept-edits": "acceptEdits",
  auto: "auto",
  "full-access": "bypassPermissions",
};

/**
 * The tools that get a file read approval. Command and file-change approvals
 * are chosen by the item kind from `classifyTool`, so the two cannot disagree,
 * but reading has no item kind of its own, so it needs this list.
 */
const FILE_READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep"]);

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

/**
 * Builds the request the user answers for one tool call. Every field is
 * truncated to what the protocol accepts: a command or path that is too long
 * would make a frame nobody can decode, which loses the event and leaves the
 * park waiting for ever.
 */
const buildOpenRequest = (
  requestId: string,
  itemId: string,
  toolName: string,
  input: Record<string, unknown>,
  canPersist: boolean,
): OpenRequest => {
  if (toolName === "AskUserQuestion") {
    return buildQuestionRequest({ requestId, itemId }, toolName, input["questions"]);
  }
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
  if (FILE_READ_TOOLS.has(toolName)) {
    return { ...common, kind: "file_read_approval", detail: { paths: readInputPaths(input) } };
  }
  return { ...common, kind: "tool_approval", detail: { toolName: truncateFact(toolName) } };
};

/** The message the model gets when the user denies a tool call; the SDK requires one. */
const REFUSED = "the user did not allow this";

const CANCELLED = "the user cancelled this turn";

/**
 * Converts a user's decision into the SDK's permission result.
 *
 * - `cancel` is a deny with `interrupt: true`, so the turn ends instead of the
 *   model trying something else.
 * - `decisionClassification` tells the harness who decided.
 * - `allow_always` returns the rules the harness suggested, unchanged apart
 *   from where they are saved.
 */
const buildPermissionResult = (
  decision: ApprovalDecision,
  persists: ReadonlyArray<PermissionUpdate>,
): PermissionResult => {
  switch (decision) {
    case "allow":
      return { behavior: "allow", decisionClassification: "user_temporary" };
    case "allow_always":
      return {
        behavior: "allow",
        updatedPermissions: [...persists],
        decisionClassification: "user_permanent",
      };
    case "deny":
      return { behavior: "deny", message: REFUSED, decisionClassification: "user_reject" };
    case "cancel":
      return {
        behavior: "deny",
        message: CANCELLED,
        interrupt: true,
        decisionClassification: "user_reject",
      };
  }
};

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
 * Returns the plugins for a session: only Hercule's own plugin, which gives the
 * agent Hercule as a tool (spec 06 section 9.3). The runner writes the plugin
 * into a directory at startup, and it is loaded from there by path. This is all
 * this adapter knows about the skill.
 *
 * The plugin is loaded by path, independently of `settingSources`, which stays
 * empty, so no other settings on this runner are picked up.
 */
const buildPlugins = (ctx: ProviderRunnerContext): NonNullable<Options["plugins"]> => [
  { type: "local", path: ctx.herculeTool.claudePluginDir },
];

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
 * Returns the SDK options for a session. Unlike a probe, a session runs the
 * user's work, so it gets the workspace as its working directory and the
 * instance's home as its config directory. Auto memory is off and
 * `settingSources` is empty because Hercule decides what context a session
 * gets, not whatever files happen to be on this runner (spec 06 sections 4.2
 * and 10.1).
 */
const buildSessionOptions = (
  ctx: ProviderRunnerContext,
  spec: SessionSpec,
  binary: string,
  native: Options,
  canUseTool: CanUseTool,
): Options => {
  const effort = readEffort(spec.modelSelection.options);
  const disallowedTools = (spec.disallowedTools ?? []).flatMap(
    (family) => CLAUDE_TOOLS_BY_FAMILY[family],
  );
  return {
    pathToClaudeCodeExecutable: binary,
    ...native,
    // Each of these three fields is set only when the session spec has it. An
    // empty list, or a preset with nothing appended, would add a setting nobody
    // asked for.
    ...(spec.systemPrompt === undefined
      ? {}
      : { systemPrompt: { type: "preset", preset: "claude_code", append: spec.systemPrompt } }),
    ...(disallowedTools.length === 0 ? {} : { disallowedTools }),
    ...(spec.outputSchema === undefined
      ? {}
      : { outputFormat: { type: "json_schema", schema: spec.outputSchema } }),
    ...(ctx.cwd === null ? {} : { cwd: ctx.cwd }),
    settingSources: [],
    strictMcpConfig: true,
    includePartialMessages: true,
    model: spec.modelSelection.model,
    ...(effort === undefined ? {} : { effort }),
    permissionMode: PERMISSION_MODES[spec.accessMode],
    // Pass the callback in every mode except `full-access`. When permissions
    // are skipped, the SDK ignores the callback and logs a warning about it.
    ...(spec.accessMode === "full-access"
      ? { allowDangerouslySkipPermissions: true }
      : { canUseTool }),
    env: { ...buildEnv(ctx), CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
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

/**
 * An open request the harness is waiting on for an answer. The promise the
 * harness awaits is hidden in the closures; everything else only needs the
 * request id, the allowed decisions, and a way to end the wait.
 */
interface Park {
  readonly requestId: string;
  readonly decisions: ReadonlyArray<ApprovalDecision>;
  /** Sends the decision to the harness in the SDK's terms, and the harness continues. */
  readonly answer: (decision: ApprovalDecision) => void;
  /**
   * Ends the request without an answer from the user. This happens when:
   *
   * - the turn was interrupted;
   * - the session stopped;
   * - the harness withdrew the request;
   * - the harness's stream ended.
   *
   * The event stream reports the request as cancelled, because the user did
   * not deny it. The harness gets a plain deny, because there is no turn left
   * to interrupt.
   */
  readonly withdraw: () => void;
}

/** One session this adapter is hosting. */
interface Live {
  readonly binding: SessionBinding;
  readonly input: Pushable<SDKUserMessage>;
  readonly stream: ClaudeStream;
  readonly state: Normalizing;
  /**
   * The request this session is waiting on, if any. There is at most one at a
   * time: the harness waits on a park before it runs more tools, and the
   * clients show one approval card. The park is stored on the session entry,
   * not in a separate map, because it is a promise inside the harness's own
   * call, so it must go away with the session that waits on it.
   */
  park: Park | undefined;
  /** Set by `stopSession` to its reason, so the `session.exited` event can report it. */
  stopping: ExitReason | undefined;
  /** The model the harness is using. It starts as the model in the session spec. */
  model: string;
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
   * Builds the `canUseTool` callback the harness calls to ask for approval
   * (spec 06 section 8.2). The promise the callback returns is the park. It
   * stays open until one of these happens:
   *
   * - the user answers;
   * - the harness withdraws the request by aborting the signal;
   * - the session ends.
   *
   * The park is stored on the session's entry, under a request id the adapter
   * creates. Every answer comes back with that request id.
   */
  const buildCanUseTool =
    (sessionId: string): CanUseTool =>
    (toolName, input, options) =>
      new Promise<PermissionResult>((settle) => {
        const held = live.get(sessionId);
        // Deny by default, using the same check that rejects input: when the
        // session is gone or stopping, nobody is left to answer, and the park
        // would hold the harness for ever.
        if (held === undefined || held.stopping !== undefined) {
          settle(buildPermissionResult("deny", []));
          return;
        }
        // Already withdrawn before it was shown: the turn is being
        // interrupted, so there is nothing to show the user.
        if (options.signal.aborted) {
          settle(buildPermissionResult("deny", []));
          return;
        }
        // One request at a time. A second request would replace the card the
        // user is looking at, so the second request is denied, with a message
        // that tells the model to ask again once the first is answered.
        if (held.park !== undefined) {
          settle({
            behavior: "deny",
            message:
              "another approval is still waiting for the user; ask again after it is answered",
            decisionClassification: "user_reject",
          });
          return;
        }
        // "Allow always" applies to this thread, not to the user's machine.
        // Every rule the harness suggested saving is redirected to the session,
        // so no click here edits a settings file on disk.
        const persists = (options.suggestions ?? []).map((rule) => ({
          ...rule,
          destination: "session" as const,
        }));
        const requestId = crypto.randomUUID();
        // A park belongs to a turn: the turn is waiting on it, and the
        // supervisor pauses an open turn's inactivity timer while it waits. The
        // SDK can ask before the assistant message that starts the turn has
        // been read from its stream, so open the turn here if none is open yet.
        const { events } = openTurn(held.state);
        for (const event of events) emit(event);
        const request = buildOpenRequest(
          requestId,
          // An id the protocol does not accept would make a frame nobody can
          // decode, which loses the event and leaves a park no client can see.
          options.toolUseID === "" ? held.state.mint() : truncateFact(options.toolUseID),
          toolName,
          input,
          persists.length > 0,
        );
        const endPark = (decision: ApprovalDecision, told: PermissionResult): void => {
          // End the park only if it is still this request's park, so a
          // second answer does nothing.
          if (held.park?.requestId !== requestId) return;
          held.park = undefined;
          options.signal.removeEventListener("abort", withdraw);
          emit({
            _tag: "request.resolved",
            eventId: held.state.mint(),
            sessionId,
            at: held.state.now(),
            requestId,
            decision,
          });
          settle(told);
        };
        // Handles every way the request can end without an answer: the harness
        // withdraws it, the turn is interrupted, the session stops, or the
        // harness's stream ends.
        const withdraw = (): void => endPark("cancel", buildPermissionResult("deny", []));
        options.signal.addEventListener("abort", withdraw, { once: true });
        held.park = {
          requestId,
          decisions: request.decisions,
          answer: (decision) => endPark(decision, buildPermissionResult(decision, persists)),
          withdraw,
        };
        emit({
          _tag: "request.opened",
          eventId: held.state.mint(),
          sessionId,
          at: held.state.now(),
          request,
        });
      });

  /** Returns the hosted session. Fails when there is none, or when it is stopping. */
  const getHostedSession = (sessionId: string): Effect.Effect<Live, string> =>
    Effect.suspend(() => {
      const held = live.get(sessionId);
      return held === undefined || held.stopping !== undefined
        ? Effect.fail(`session ${sessionId} is not running here`)
        : Effect.succeed(held);
    });

  /**
   * Reads the harness's messages until its stream ends, and emits their events.
   * Then emits `session.exited` with the reason. Never rejects.
   */
  const pumpEvents = async (sessionId: string, held: Live): Promise<void> => {
    let reason: ExitReason = "process_exit";
    try {
      for await (const sdk of held.stream) {
        for (const event of normalize(held.state, sdk)) emit(event);
      }
    } catch (error) {
      reason = "crash";
      // Ending the query rejects whatever was in progress, and a normal stop
      // should not be reported as a runtime error.
      if (held.stopping === undefined) {
        emit({
          _tag: "runtime.error",
          eventId: crypto.randomUUID(),
          sessionId,
          at: now(),
          class: "unknown",
          message: describeError(error),
        });
      }
    } finally {
      // Every exit passes through here, so end the park here, before the exit
      // is reported. A park left open is a promise the harness waits on for
      // ever, and it leaves an approval card on a session that is gone, which
      // nobody can answer.
      held.park?.withdraw();
      // Compare by identity: a session started again under the same id has a
      // new entry, and that entry belongs to a different pump.
      if (live.get(sessionId) === held) live.delete(sessionId);
      emit({
        _tag: "session.exited",
        eventId: crypto.randomUUID(),
        sessionId,
        at: now(),
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
    ): Effect.Effect<SessionBinding, string> =>
      Effect.suspend(() => {
        const binary = ctx.binary;
        if (binary === undefined) {
          return Effect.fail(`no ${CLAUDE_BINARY} on this machine`);
        }
        // Two harnesses under one Hercule session id would mix up their events
        // and their exits, so the second start fails.
        if (live.has(sessionId)) {
          return Effect.fail(`session ${sessionId} is already running here`);
        }
        const native = resolveNativeSession(spec);
        const binding: SessionBinding = {
          sessionId,
          nativeSessionId: native.nativeSessionId,
          instanceId: spec.instanceId,
        };
        const input = createPushable<SDKUserMessage>();
        return Effect.map(
          Effect.try({
            try: () =>
              seam.stream({
                options: buildSessionOptions(
                  ctx,
                  spec,
                  binary,
                  native.options,
                  buildCanUseTool(sessionId),
                ),
                input,
              }),
            catch: describeError,
          }),
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
              ),
              park: undefined,
              stopping: undefined,
              model: spec.modelSelection.model,
            };
            live.set(sessionId, held);
            void pumpEvents(sessionId, held);
            // The event carries the native id because the controller has no
            // other way to learn it: `sessionsReport` is sent only once, at
            // hello, so it never includes a session started after that.
            emit({
              _tag: "session.started",
              eventId: crypto.randomUUID(),
              sessionId,
              at: now(),
              providerRefs: { nativeSessionId: binding.nativeSessionId },
            });
            return binding;
          },
        );
      }),

    sendInput: (sessionId: string, turn: TurnInput): Effect.Effect<SendResult, string> =>
      Effect.gen(function* () {
        const model = turn.modelSelection?.model;
        const before = yield* getHostedSession(sessionId);
        // Change the model only when a new turn is about to open: during a
        // turn, the harness keeps the model the turn started with. Only ask
        // when the model differs from the one last applied, so a session with
        // nothing to change never waits on the harness. If the harness rejects
        // the model, the input fails: sending it under the old model would run
        // a turn the caller did not ask for.
        if (model !== undefined && model !== before.model && before.state.turnId === undefined) {
          const refused = yield* sendControlRequest(before.stream.setModel(model));
          if (refused !== undefined) {
            return yield* Effect.fail(`the model was not changed to ${model}: ${refused}`);
          }
          before.model = model;
        }
        // Look the session up again: `setModel` waits on the harness, and in
        // the meantime a turn may have opened or ended, or the session may have
        // stopped.
        const held = yield* getHostedSession(sessionId);
        const { turnId, events } = openTurn(held.state);
        for (const event of events) emit(event);
        // Steering is implicit: if `openTurn` did not open a new turn, a turn
        // is already running, and the input joins it. Decide from what
        // `openTurn` just did, not from what was true before the wait.
        const steered = events.length === 0;
        for (const event of buildUserMessage({ sessionId, turnId, text: turn.text, steered })) {
          emit(event);
        }
        held.input.push({
          type: "user",
          message: { role: "user", content: turn.text },
          parent_tool_use_id: null,
          session_id: held.binding.nativeSessionId,
        });
        return { turnId, delivery: steered ? "steered" : "opened" };
      }),

    interrupt: (sessionId: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        const held = live.get(sessionId);
        // No turn is running, so do not send the harness a control request: it
        // would wait on the harness and hold up the connection's other frames.
        if (held === undefined || held.state.turnId === undefined) return Effect.void;
        // End the park before sending the interrupt, not after. The CLI
        // withdraws a pending request once the turn is interrupted, and a
        // request still open when the turn completes leaves a card on screen
        // for a turn that is over.
        held.park?.withdraw();
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
        // Do not end the park here: closing the stream ends the pump, and the
        // pump's `finally` ends the park on every exit.
        held.input.end();
        held.stream.close();
      }),

    respondToRequest: (
      sessionId: string,
      requestId: string,
      decision: ApprovalDecision,
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        const park = live.get(sessionId)?.park;
        if (park === undefined || park.requestId !== requestId) return;
        // Ignore a decision the request did not offer: the harness would have
        // to replace it with something else.
        if (!park.decisions.includes(decision)) return;
        park.answer(decision);
      }),

    listSessions: Effect.sync(() => [...live.values()].map((held) => held.binding)),

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
  stream: ({ options, input }) => {
    const running: Query = sdkQuery({ prompt: input, options });
    return {
      [Symbol.asyncIterator]: () => running[Symbol.asyncIterator](),
      interrupt: () => running.interrupt().then(() => undefined),
      setModel: (model) => running.setModel(model),
      close: () => {
        // The child may already be gone, and an unhandled rejection would take
        // the whole daemon down just because one session ended.
        running.return(undefined).catch(() => undefined);
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
