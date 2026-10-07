/**
 * The pi adapter. It runs one pi process per session, plus one per running
 * subagent, and talks to each in pi's RPC mode. Everything the processes read
 * or write lives under the instance's own agent directory. If pi used the developer's own directory, Hercule's
 * sessions would mix with the user's login, skills and settings. The one
 * exception is a Thread on the controller's local runner, which also reads the
 * user's own skills, prompt templates and instructions, each named on its
 * command line.
 */
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type {
  ApprovalDecision,
  DisallowedTool,
  ItemKind,
  ExitReason,
  ModelSelection,
  OpenRequest,
  ProbeResult,
  ProviderEvent,
  SendResult,
  SessionBinding,
  SessionSpec,
  SubagentId,
  TurnInput,
  TurnState,
} from "@hercule/protocol";
import type { ProviderAdapter, ProviderRunnerContext, UserMaterial } from "../index";
import { buildUserMessage } from "../events";
import { buildFailedProbe } from "../probe";
import { runProcess, spawnPi, type Run } from "../process";
import { truncateFact, truncateMessage } from "../text";
import { now } from "../../report";
import {
  ACCESS_MODE_VARIABLE,
  EXTENSION_FILE,
  EXTENSION_SOURCE,
  OUTPUT_SCHEMA_VARIABLE,
  SUBAGENT_DIALOG,
  SUBAGENT_TOOL,
  SUBAGENTS_VARIABLE,
  SUBMIT_RESULT_TOOL,
  type SubagentReply,
} from "./extension";
import {
  endTurn,
  normalize,
  buildNormalizingState,
  buildSubagentState,
  buildUsageEvents,
  type Normalizing,
  type RunningTool,
} from "./normalize";
import { DEFAULT_THINKING, makePiInstall, makeProbe, ZAI } from "./probe";
import { makeRpc, PI_GONE, type PiChild, type PiRpc, type PiSpawn } from "./rpc";

export const PI = "pi";

const PI_BINARY = "pi";

/**
 * The Z.ai key: its secret name in the instance config, and the environment
 * variable pi reads it from. The runner cannot import the pi plugin, so the
 * adapter owns this mapping, the same way the Claude adapter owns
 * `CLAUDE_CONFIG_DIR`.
 */
const ZAI_KEY = { secret: "zaiApiKey", variable: "ZAI_API_KEY" };

/** How many of pi's last stderr lines are kept, to report why it exited. */
const MAX_COMPLAINT_LINES = 5;

/**
 * How long pi gets to exit by itself after its stdin is closed, even when it is
 * waiting on an approval. After that it is killed: a pi that kept running
 * would still hold the user's key while Hercule believes the session is over.
 */
const STOP_DEADLINE: Duration.Duration = Duration.seconds(2);

/**
 * The request kinds a held tool call can open. They are taken from the
 * protocol's own type, so renaming a kind there breaks the build here instead
 * of leaving an old name behind.
 */
type ParkKind = Extract<
  OpenRequest["kind"],
  "command_approval" | "file_change_approval" | "tool_approval"
>;

export interface PiSeam {
  /** The line-framed child a session is hosted on. */
  readonly spawn: PiSpawn;
  readonly run: Run;
}

/**
 * An approval one of the session's agents is parked on. `request` is what
 * every surface shows and answers. `dialogId` is pi's own id for the dialog:
 * pi reads only that id and a value back, so the answer is sent under it.
 */
interface Park {
  readonly request: OpenRequest;
  /** The agent whose pi holds the call, and which reads the answer. */
  readonly agent: RunningAgent;
  readonly dialogId: string;
  /** pi's id for the held tool call, used to recognise the call when it ends. */
  readonly toolCallId: string;
}

/** One pi process of a session: the session's own agent, or one of its subagents. */
interface RunningAgent {
  readonly child: PiChild;
  readonly rpc: PiRpc;
  /** The normalizer's state for this process. Its `subagentId` names the agent. */
  readonly state: Normalizing;
  /** How many levels below the session's own agent this agent runs: 0 for the session's own. */
  readonly depth: number;
}

/** A subagent: an agent that another agent of the session started with its `subagent` tool. */
interface Subagent extends RunningAgent {
  readonly subagentId: SubagentId;
  /** The agent whose `subagent` call started this subagent, and waits for its reply. */
  readonly parent: RunningAgent;
  /** pi's id for that call's dialog, which the reply is sent under. */
  readonly dialogId: string;
  /** The item id of that call in the parent's transcript. */
  readonly toolCallItemId: string;
}

const isSubagent = (agent: RunningAgent): agent is Subagent => "parent" in agent;

/**
 * The prompt the runner sends when a turn finishes without calling
 * `submit_result`. It is one fixed sentence, because it ends up in the
 * transcript of every session with an output schema that needs it.
 */
export const REPROMPT = `You must call ${SUBMIT_RESULT_TOOL} with your answer; do nothing else.`;

/**
 * How many times the runner re-prompts one turn before it reports that the
 * turn gave no answer. More re-prompts would risk a session that never ends.
 * Two is the default spec 06 section 7 sets for pi.
 */
const MAX_REPROMPTS = 2;

/**
 * How many answers pi may reject in one turn before the runner ends the turn.
 * pi validates each `submit_result` call against the tool's schema and returns
 * the validation error to the model as the call's result. A model that cannot
 * satisfy the schema keeps retrying for as long as it is allowed to: one live
 * session, on a schema no value could satisfy, called the tool 84 times in
 * five minutes. A few tries are enough for a model that only made a mistake.
 * After that the turn ends, and its last answer is validated as the result.
 *
 * This is one of the two limits on a pi turn with an output schema;
 * `MAX_REPROMPTS` above is the other (spec 06 section 7).
 */
const MAX_REFUSED_ANSWERS = 3;

/**
 * How many subagents one session may run at once. pi runs a message's tool
 * calls at the same time, and each subagent is a pi process with its own
 * model calls, so a model that asked for many at once could exhaust the
 * machine or the key's rate limit. A call over the limit fails at once and
 * the agent can try again later (spec 06 section 13.7).
 */
const MAX_RUNNING_SUBAGENTS = 4;

/**
 * How many levels of subagents a session may have below its own agent. An
 * agent at this depth gets no `subagent` tool, so a subagent's subagent cannot
 * start another (spec 06 section 13.7).
 */
const MAX_SUBAGENT_DEPTH = 2;

/** A session this adapter hosts, and the adapter's state for its pi processes. */
interface Held {
  readonly binding: SessionBinding;
  readonly spec: SessionSpec;
  readonly ctx: ProviderRunnerContext;
  /** The pi binary the session's own agent runs, which its subagents run too. */
  readonly binary: string;
  /** The session's own agent, whose pi process is the session's. */
  readonly root: RunningAgent;
  /** The subagents running now, by id. An ended subagent is removed. */
  readonly subagents: Map<SubagentId, Subagent>;
  /** The approvals the session's agents are parked on, by request id. */
  readonly parks: Map<string, Park>;
  /**
   * The model and thinking level the session runs on now. An input can change
   * them, and a subagent starts on whatever the session uses at that moment.
   */
  modelSelection: ModelSelection;
  /**
   * The file the session's instructions were written to, if it has any.
   * Nothing reads the file after the session's pi is gone, so it is deleted
   * with the session instead of piling up in the instance's home.
   */
  readonly systemPromptFile: string | undefined;
  /** Whether `stopSession` is stopping this session. The stop then reports the exit. */
  stopping: boolean;
  /** Counts Stops so an input waiting on an RPC reply cannot continue after its Stop. */
  inputGeneration: number;
}

/**
 * The decisions offered for a held call. "Allow always" would need the approval
 * hook to remember a rule for the rest of the session, which is not built. So
 * it is not offered, instead of silently acting as a one-time allow.
 */
const DECISIONS: readonly [ApprovalDecision, ...ReadonlyArray<ApprovalDecision>] = [
  "allow",
  "deny",
  "cancel",
];

/** Converts a decision to pi's dialog response: cancelled, or confirmed true or false. */
const buildDialogAnswer = (decision: ApprovalDecision): Record<string, unknown> =>
  decision === "cancel" ? { cancelled: true } : { confirmed: decision === "allow" };

/**
 * The request kind for a held call, by the item kind the normalizer gave the
 * call: a command, a file change, or (for anything else) a tool by name. Which
 * calls are held is decided in `policy.ts`; this only picks the kind.
 */
const APPROVALS: Readonly<Partial<Record<ItemKind, ParkKind>>> = {
  command_execution: "command_approval",
  file_change: "file_change_approval",
};

/** Returns the named string argument of a tool call, or "" when it is missing or not a string. */
const readStringArg = (item: RunningTool, name: string): string => {
  const value = item.args?.[name];
  return typeof value === "string" ? value : "";
};

/**
 * Builds the approval request the user answers. Its detail comes from the tool
 * call pi started, not from pi's dialog, because the dialog only says which
 * call it is about. Surfaces show the command, the path or the tool name.
 */
const buildOpenRequest = (requestId: string, item: RunningTool, kind: ParkKind): OpenRequest => {
  const common = { requestId, itemId: item.itemId, decisions: DECISIONS };
  if (kind === "command_approval") {
    return {
      ...common,
      kind,
      detail: { command: truncateMessage(readStringArg(item, "command")) },
    };
  }
  if (kind === "file_change_approval") {
    return { ...common, kind, detail: { paths: [truncateFact(readStringArg(item, "path"))] } };
  }
  return { ...common, kind, detail: { toolName: truncateFact(item.toolName) } };
};

/**
 * A pi dialog the extension opened, and the tool call it is about. Either the
 * approval hook holds the call until the user decides, or the `subagent` tool
 * asks the runner to start a subagent with the call's task.
 */
type Dialog =
  | { readonly kind: "approval"; readonly id: string; readonly toolCallId: string }
  | {
      readonly kind: "subagent";
      readonly id: string;
      readonly toolCallId: string;
      readonly description: string;
      readonly prompt: string;
    };

/**
 * Parses the JSON the extension wrote into a dialog: the held call for an
 * approval, or the task for a subagent. Returns an empty object when the text
 * is not a JSON object.
 */
const parseDialogJson = (message: unknown): Record<string, unknown> => {
  if (typeof message !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(message);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Only Hercule's extension opens dialogs in these sessions, so text in
    // any other shape names no call. The adapter denies an approval about no
    // call, and refuses a subagent for no call.
    return {};
  }
};

const readString = (record: Record<string, unknown>, key: string): string =>
  typeof record[key] === "string" ? record[key] : "";

/**
 * Parses a frame as a dialog the extension opened. Returns undefined for any
 * other frame. Only two requests count: a `confirm` from the approval hook,
 * and an `input` from the `subagent` tool, which pi sends with the JSON in
 * its placeholder. pi also sends notifications and status updates as
 * requests, and those need no response.
 */
const parseDialog = (frame: unknown): Dialog | undefined => {
  if (typeof frame !== "object" || frame === null) return undefined;
  const asked = frame as Record<string, unknown>;
  const id = asked["id"];
  if (asked["type"] !== "extension_ui_request" || typeof id !== "string") return undefined;
  if (asked["method"] === "confirm") {
    const held = parseDialogJson(asked["message"]);
    return { kind: "approval", id, toolCallId: readString(held, "toolCallId") };
  }
  if (asked["method"] === "input" && asked["title"] === SUBAGENT_DIALOG) {
    const task = parseDialogJson(asked["placeholder"]);
    return {
      kind: "subagent",
      id,
      toolCallId: readString(task, "toolCallId"),
      description: readString(task, "description"),
      prompt: readString(task, "prompt"),
    };
  }
  return undefined;
};

/**
 * Builds the reply a subagent gives its parent from how its turn ended: its
 * last message when the turn completed, and otherwise why it has none.
 */
const buildSubagentReply = (
  ended: TurnState,
  lastAssistantText: string,
  error: string | undefined,
): SubagentReply => {
  if (ended === "completed") {
    return {
      text:
        lastAssistantText === ""
          ? "The subagent finished without a final message."
          : lastAssistantText,
    };
  }
  if (ended === "interrupted") return { error: "The subagent was stopped before it finished." };
  return { error: error === undefined ? "The subagent failed." : `The subagent failed: ${error}` };
};

/** The reply a subagent's parent gets when the user stops the subagent. */
const STOPPED_BY_USER: SubagentReply = { error: "The user stopped this subagent." };

/** Checks whether a frame is pi's `agent_settled` event: pi has nothing left to run for now. */
const announcesAgentSettled = (frame: unknown): boolean =>
  typeof frame === "object" &&
  frame !== null &&
  (frame as { readonly type?: unknown }).type === "agent_settled";

/**
 * Checks whether the runner should re-prompt the turn when pi settles. All of
 * these must hold:
 *
 * - the session has an output schema;
 * - a turn is in flight and has not answered yet;
 * - the turn has re-prompts left;
 * - the system did not end the turn;
 * - pi's run completed normally.
 */
const owesAnswer = (state: Normalizing): boolean =>
  state.outputSchema !== undefined &&
  state.turnId !== undefined &&
  state.answer === undefined &&
  state.reprompts < MAX_REPROMPTS &&
  // A turn the system ended is over. Re-prompting it would restart a session
  // the user just stopped, and the turn would never close.
  state.endedBySystem === undefined &&
  // A run that failed or was aborted is over too. Only a run that completed
  // had the chance to answer and did not.
  state.stopped.state === "completed";

/**
 * Returns the directory for session transcripts inside the instance's home.
 * pi names each transcript after the session's start time and id.
 */
const buildSessionsDir = (home: string): string => join(home, "sessions");

const buildExtensionPath = (home: string): string => join(home, EXTENSION_FILE);

/** Returns the path of the copy of the extension one subagent loads (see `startSubagent`). */
const buildSubagentExtensionPath = (home: string, subagentId: SubagentId): string =>
  join(home, `subagent-extension-${subagentId}.ts`);

/**
 * Returns the path the Agent's instructions for one session are written to,
 * beside the extension. When the `--append-system-prompt` value names a file
 * pi can open, pi reads that file; otherwise it uses the value as the text.
 * The adapter always passes a path, for two reasons:
 *
 * - instructions on the command line would be visible in the machine's
 *   process list;
 * - a prompt that looks like a filename, such as `AGENTS.md`, would be
 *   replaced by the contents of that file.
 */
const buildSystemPromptPath = (home: string, sessionId: string): string =>
  join(home, `system-prompt-${sessionId}.txt`);

const getSessionThinkingLevel = (selection: ModelSelection): string => {
  const picked = selection.options["thinking"];
  return typeof picked === "string" && picked !== "" ? picked : DEFAULT_THINKING;
};

/**
 * Finds the transcript file of a native session by its id. Returns undefined
 * when there is none. pi is given the path, not the id: with a bare id, pi
 * searches the sessions of the current directory, and when it has to search
 * wider it asks a question on stdin, which is Hercule's JSON channel.
 */
const findTranscript = (home: string, nativeSessionId: string): string | undefined => {
  let names: ReadonlyArray<string>;
  try {
    names = readdirSync(buildSessionsDir(home));
  } catch {
    return undefined;
  }
  const found = names.find((name) => name.endsWith(`_${nativeSessionId}.jsonl`));
  return found === undefined ? undefined : join(buildSessionsDir(home), found);
};

/**
 * The pi 0.85.1 tools in each tool family of the session spec. The two web
 * families map to no tool, because pi has no web tool and fails to start when
 * given a tool name it does not know.
 */
const PI_TOOLS_BY_FAMILY: Readonly<Record<DisallowedTool, ReadonlyArray<string>>> = {
  edit: ["edit"],
  write: ["write"],
  shell: ["bash"],
  "web-search": [],
  "web-fetch": [],
};

/**
 * Builds the flags that load the user's own material into one pi process:
 * `--skill` per skill directory, `--prompt-template` per prompt template
 * directory, and `--append-system-prompt` with the instructions file when the
 * user has one. Returns no flags when there is no material, which is the case
 * for every session that is not a Thread on the controller's local runner.
 */
const buildUserMaterialFlags = (material: UserMaterial | undefined): ReadonlyArray<string> =>
  material === undefined
    ? []
    : [
        ...material.skillDirs.flatMap((dir) => ["--skill", dir]),
        ...material.promptTemplateDirs.flatMap((dir) => ["--prompt-template", dir]),
        ...(material.instructionsFile === undefined
          ? []
          : ["--append-system-prompt", material.instructionsFile]),
      ];

/**
 * Which pi process `buildArgv` builds the arguments for: the session's own,
 * with the transcript it continues, if any, or a subagent's, with the copy of
 * the extension written for it alone.
 */
type AgentLaunch =
  | {
      readonly kind: "session";
      readonly sessionId: string;
      readonly transcript: string | undefined;
    }
  | { readonly kind: "subagent"; readonly extensionFile: string };

/**
 * Builds pi's command-line arguments for a session's own pi process, or for a
 * subagent's.
 *
 * - A new session gets Hercule's session id with `--session-id`. A resume
 *   passes the transcript with `--session` instead: pi rejects the two
 *   together, because the transcript already has its own session id.
 * - A subagent keeps no transcript (`--no-session`), because it lives only
 *   as long as its one task. It gets the same tools, access and user material
 *   as the session, but not the Agent's instructions: its parent's prompt is
 *   its whole brief.
 */
const buildArgv = (
  spec: SessionSpec,
  ctx: ProviderRunnerContext,
  selection: ModelSelection,
  launch: AgentLaunch,
): ReadonlyArray<string> => {
  const session = launch.kind === "session" ? launch : undefined;
  const transcript = session?.transcript;
  const resuming = spec.continue?.mode === "resume" && transcript !== undefined;
  const excluded = (spec.disallowedTools ?? []).flatMap((family) => PI_TOOLS_BY_FAMILY[family]);
  return [
    "--mode",
    "rpc",
    // A session with a workspace reads context files, because the
    // repository's instructions are part of the work. pi then reads the
    // `AGENTS.md` or `CLAUDE.md` in the workspace and in every directory above
    // it, which is accepted. A session without one runs in an empty scratch
    // directory and reads no context file, so no stray file on this runner can
    // reach it. Either way the agent directory pi also reads is the instance's
    // home, never the user's own (spec 06 section 9.1). A Thread that sees the
    // user's material gets the user's instructions file through its own flag,
    // after the Agent's own system prompt.
    ...(spec.workspaceId === null ? ["--no-context-files"] : []),
    // Load nothing else of the user's own: a Hercule session runs only on what
    // the controller configured for it, not on whatever this machine has
    // installed.
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    // Hercule handles approvals through the extension below. pi's own prompt
    // would appear on the JSON channel, where no person is reading it.
    "--no-approve",
    "--offline",
    "-e",
    launch.kind === "session" ? buildExtensionPath(ctx.home) : launch.extensionFile,
    ...(session === undefined
      ? ["--no-session"]
      : [
          "--session-dir",
          buildSessionsDir(ctx.home),
          ...(resuming ? ["--session", transcript] : ["--session-id", session.sessionId]),
          ...(spec.continue?.mode === "fork" && transcript !== undefined
            ? ["--fork", transcript]
            : []),
        ]),
    "--model",
    `${ZAI}/${selection.model}`,
    "--thinking",
    getSessionThinkingLevel(selection),
    // Added after pi's own system prompt, never replacing it, and passed as
    // the path `prepareHome` wrote it to, not as the text.
    ...(spec.systemPrompt === undefined || session === undefined
      ? []
      : ["--append-system-prompt", buildSystemPromptPath(ctx.home, session.sessionId)]),
    // A Thread on the controller's local runner is the exception to the
    // `--no-*` flags above: it also sees the user's own skills, prompt
    // templates and instructions (spec 06 section 9.1). pi still loads a
    // directory named with `--skill` or `--prompt-template` under those flags.
    // The material goes on this process's command line, not into the
    // instance's agent directory, because every session of the instance reads
    // that directory. The user's extensions never load, even for a Thread.
    //
    // pi appends each `--append-system-prompt` in the order given, so the
    // user's instructions come after the Agent's own system prompt, as they
    // do for Codex.
    ...buildUserMaterialFlags(ctx.userMaterial),
    // pi reads a flag with an empty value as an unknown flag, so the flag is
    // left out when there is nothing to exclude.
    ...(excluded.length === 0 ? [] : ["--exclude-tools", excluded.join(",")]),
  ];
};

export const makePiAdapter = (seam: PiSeam): ProviderAdapter => {
  // Creating an unbounded PubSub allocates and nothing more, so it is safe to
  // run here and keeps `findAdapter` the synchronous lookup every other caller
  // already treats it as.
  const published = Effect.runSync(PubSub.unbounded<ProviderEvent>());
  const sessions = new Map<string, Held>();

  const emit = (event: ProviderEvent): void => {
    PubSub.publishUnsafe(published, event);
  };

  /** Emits a runtime warning from the adapter itself, not from pi, on the session's stream. */
  const warn = (sessionId: string, message: string): void => {
    emit({
      _tag: "runtime.warning",
      eventId: crypto.randomUUID(),
      sessionId,
      at: now(),
      message: truncateMessage(message),
    });
  };

  /**
   * Runs `act` and ignores any error. A broken pipe throws on every write and
   * on the kill after it, but the session is over either way.
   */
  const attempt = (act: () => void): void => {
    try {
      act();
    } catch {
      // The child is already gone, so there is nothing to do.
    }
  };

  /** Writes one response to a dialog the extension opened in `agent`'s pi. */
  const answerDialog = (
    agent: RunningAgent,
    dialogId: string,
    answer: Record<string, unknown>,
  ): void => {
    attempt(() =>
      agent.child.write(
        `${JSON.stringify({ type: "extension_ui_response", id: dialogId, ...answer })}\n`,
      ),
    );
  };

  /** Answers the dialog of a `subagent` call in `agent`'s pi with the subagent's reply, or a refusal. */
  const answerSubagentDialog = (
    agent: RunningAgent,
    dialogId: string,
    reply: SubagentReply,
  ): void => {
    answerDialog(agent, dialogId, { value: JSON.stringify(reply) });
  };

  /**
   * Resolves one open approval. It sends the decision to the pi that holds
   * the call, so the call runs or is blocked, and emits `request.resolved`,
   * so surfaces stop offering the card.
   */
  const resolvePark = (held: Held, park: Park, decision: ApprovalDecision): void => {
    held.parks.delete(park.request.requestId);
    // Mark the call as declined, so the transcript shows the user's decision
    // instead of a failed call.
    if (decision !== "allow") park.agent.state.declined.add(park.toolCallId);
    answerDialog(park.agent, park.dialogId, buildDialogAnswer(decision));
    const subagentId = park.agent.state.subagentId;
    emit({
      _tag: "request.resolved",
      eventId: crypto.randomUUID(),
      sessionId: held.binding.sessionId,
      at: now(),
      ...(subagentId === undefined ? {} : { subagentId }),
      requestId: park.request.requestId,
      decision,
    });
  };

  /** Cancels every open approval of `agent`. Nobody decided them; their agent stopped waiting. */
  const cancelParksOf = (held: Held, agent: RunningAgent): void => {
    for (const park of [...held.parks.values()]) {
      if (park.agent === agent) resolvePark(held, park, "cancel");
    }
  };

  /**
   * Aborts the turn an agent's pi is running. The `turn.completed` event
   * reports the end. The reason is recorded here in `endedBySystem` instead of
   * read back from pi, because pi reports an abort during a tool call as an
   * error on the message in flight, while the turn actually ended because the
   * system asked.
   */
  const abortTurn = (
    agent: RunningAgent,
    reason: NonNullable<Normalizing["endedBySystem"]>,
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      agent.state.endedBySystem ??= reason;
      return Effect.ignore(agent.rpc.send({ type: "abort" }));
    });

  /**
   * Handles a pi approval dialog: opens an approval request for the held
   * call, or denies the dialog at once when the call is unknown. Each agent
   * may have several approvals open at once, because pi runs a message's tool
   * calls at the same time; each is answered on its own.
   */
  const openPark = (held: Held, agent: RunningAgent, dialog: Dialog): void => {
    const sessionId = held.binding.sessionId;
    const item = agent.state.tools.get(dialog.toolCallId);
    if (item === undefined) {
      // The approval card is shown on the call it is about, and no such call
      // is running. Denying is the only way to avoid pi holding a call that
      // nobody will ever answer.
      answerDialog(agent, dialog.id, buildDialogAnswer("deny"));
      warn(sessionId, "pi asked for approval of a tool call that is not running, so it was denied");
      return;
    }
    const request = buildOpenRequest(
      crypto.randomUUID(),
      item,
      APPROVALS[item.kind] ?? "tool_approval",
    );
    held.parks.set(request.requestId, {
      request,
      agent,
      dialogId: dialog.id,
      toolCallId: dialog.toolCallId,
    });
    const subagentId = agent.state.subagentId;
    emit({
      _tag: "request.opened",
      eventId: crypto.randomUUID(),
      sessionId,
      at: now(),
      ...(subagentId === undefined ? {} : { subagentId }),
      request,
    });
  };

  /** Returns the running subagents `agent` started itself. */
  const listStartedBy = (held: Held, agent: RunningAgent): ReadonlyArray<Subagent> =>
    [...held.subagents.values()].filter((subagent) => subagent.parent === agent);

  /**
   * Ends every running subagent `agent` started, as interrupted and with no
   * reply, because `agent` no longer waits for one.
   */
  const endSubagentsStartedBy = (held: Held, agent: RunningAgent): void => {
    for (const subagent of listStartedBy(held, agent)) {
      endSubagent(held, subagent, { state: "interrupted" }, undefined);
    }
  };

  /**
   * Closes a subagent's pi: aborts whatever it is running, closes its stdin,
   * which makes pi exit, and kills it if it is still running after
   * `STOP_DEADLINE`. A subagent keeps no transcript, so nothing is lost either
   * way, but a pi left running would keep the instance's key and its model
   * calls.
   */
  const closeProcess = (child: PiChild): void => {
    // Without the abort, a subagent stopped mid model call waits for that
    // call before it reads the end of its input. Nothing waits for pi's
    // response, because the process is going away.
    attempt(() => child.write(`${JSON.stringify({ type: "abort" })}\n`));
    attempt(() => child.end());
    Effect.runFork(
      Effect.timeoutOption(
        Effect.promise(() => child.exited),
        STOP_DEADLINE,
      ).pipe(
        Effect.tap((exited) =>
          Option.isNone(exited) ? Effect.sync(() => attempt(() => child.kill())) : Effect.void,
        ),
      ),
    );
  };

  /**
   * Ends a running subagent, after first ending every subagent below it. Does
   * nothing when the subagent has already ended. For the subagent it:
   *
   * - cancels its open approvals;
   * - ends its turn as `ended` says, when the turn is still open;
   * - sends `reply` to its parent, unless `reply` is undefined because the
   *   parent's call no longer waits for one;
   * - closes its pi process.
   */
  const endSubagent = (
    held: Held,
    subagent: Subagent,
    ended: Normalizing["stopped"],
    reply: SubagentReply | undefined,
  ): void => {
    if (held.subagents.get(subagent.subagentId) !== subagent) return;
    held.subagents.delete(subagent.subagentId);
    endSubagentsStartedBy(held, subagent);
    cancelParksOf(held, subagent);
    for (const event of endTurn(subagent.state, ended)) emit(event);
    if (reply !== undefined) answerSubagentDialog(subagent.parent, subagent.dialogId, reply);
    closeProcess(subagent.child);
  };

  /**
   * Returns why the adapter refuses the subagent `parent`'s call asks for, or
   * undefined when it may start. The runner checks the depth itself: the
   * missing `subagent` tool at the deepest level only keeps the model from
   * being offered it, and an extension file changed on disk could offer it
   * anyway.
   */
  const findRefusal = (held: Held, parent: RunningAgent): string | undefined => {
    if (parent.depth >= MAX_SUBAGENT_DEPTH) {
      return `Subagents may only go ${String(MAX_SUBAGENT_DEPTH)} levels deep, and this agent is at the deepest level. Do the task yourself.`;
    }
    // A session being stopped, or a turn being aborted, would close the new
    // subagent at once, after it had already started a model call.
    if (held.stopping || parent.state.endedBySystem !== undefined) {
      return "This agent is being stopped, so it cannot start a subagent.";
    }
    if (held.subagents.size >= MAX_RUNNING_SUBAGENTS) {
      return `This session already runs ${String(MAX_RUNNING_SUBAGENTS)} subagents, the most it may run at once. Wait for one of them to finish, or do the task yourself.`;
    }
    return undefined;
  };

  /**
   * Starts the subagent an agent's `subagent` tool asked for: a pi process of
   * its own, on the session's current model, prompted with the call's task.
   * The call fails at once, with the reason as its result, when `findRefusal`
   * refuses it or the process cannot start.
   *
   * The subagent loads a copy of the extension written for it alone, under a
   * name that includes its new id, and deleted when it exits. An agent that
   * may write files without asking could otherwise rewrite the shared
   * extension file before the subagent loads it, and so run the subagent
   * without the approval hook.
   */
  const startSubagent = (
    held: Held,
    parent: RunningAgent,
    dialog: Extract<Dialog, { kind: "subagent" }>,
  ): void => {
    const refuse = (error: string): void => answerSubagentDialog(parent, dialog.id, { error });
    const item = parent.state.tools.get(dialog.toolCallId);
    // The subagent's row is the call's item, so a request about no running
    // call has nowhere to show, as for an approval about no call.
    if (item === undefined || item.toolName !== SUBAGENT_TOOL) {
      refuse("Hercule found no running subagent call for this request.");
      warn(held.binding.sessionId, "pi asked for a subagent for a call that is not running");
      return;
    }
    const refusal = findRefusal(held, parent);
    if (refusal !== undefined) {
      refuse(refusal);
      return;
    }
    const subagentId = crypto.randomUUID();
    const depth = parent.depth + 1;
    const extensionFile = buildSubagentExtensionPath(held.ctx.home, subagentId);
    const removeExtension = (): void => attempt(() => rmSync(extensionFile, { force: true }));
    let child: PiChild;
    try {
      writeFileAtomically(extensionFile, EXTENSION_SOURCE);
      child = seam.spawn(
        [
          held.binary,
          ...buildArgv(held.spec, held.ctx, held.modelSelection, {
            kind: "subagent",
            extensionFile,
          }),
        ],
        buildAgentEnv(held.ctx, held.spec, depth),
        held.ctx.cwd,
      );
    } catch (error) {
      removeExtension();
      const message = error instanceof Error ? error.message : String(error);
      refuse(`The subagent could not start: ${message}`);
      warn(held.binding.sessionId, `could not start a pi subagent: ${message}`);
      return;
    }
    void child.exited.then(removeExtension, removeExtension);
    item.subagentId = subagentId;
    const state = buildSubagentState(held.root.state, subagentId);
    const subagent: Subagent = {
      child,
      rpc: makeRpc(child, (line, frame) => onLine(held, subagent, line, frame)),
      state,
      depth,
      subagentId,
      parent,
      dialogId: dialog.id,
      toolCallItemId: item.itemId,
    };
    held.subagents.set(subagentId, subagent);
    const parentSubagentId = parent.state.subagentId;
    emit({
      _tag: "subagent.started",
      eventId: crypto.randomUUID(),
      sessionId: held.binding.sessionId,
      at: now(),
      subagentId,
      ...(parentSubagentId === undefined ? {} : { parentSubagentId }),
      itemId: item.itemId,
      ...(dialog.description === "" ? {} : { description: truncateMessage(dialog.description) }),
    });
    watchChild(held, subagent);
    Effect.runFork(subagent.rpc.pump);
    // Create the id before sending, as `sendInput` does: pi's `agent_start`
    // can arrive before its response to the prompt.
    const turnId = (state.turnId = crypto.randomUUID());
    for (const event of buildUserMessage({
      sessionId: held.binding.sessionId,
      subagentId,
      turnId,
      text: dialog.prompt,
      steered: false,
      providerRefs: { nativeSessionId: held.binding.nativeSessionId },
    })) {
      emit(event);
    }
    Effect.runFork(
      Effect.catch(subagent.rpc.send({ type: "prompt", message: dialog.prompt }), (error) =>
        Effect.sync(() => {
          // A pi that exited is reported by `watchChild`, with its stderr as
          // the reason, which says more than this error does.
          if (error === PI_GONE) return;
          endSubagent(
            held,
            subagent,
            { state: "failed", error: `pi did not take the subagent's task: ${error}` },
            { error: `The subagent could not start: ${error}` },
          );
        }),
      ),
    );
  };

  /**
   * Ends a session, whichever way it ended: removes its entry, ends its
   * subagents, cancels its open approvals, ends its turn and emits
   * `session.exited`. `message` is pi's last stderr output; it becomes both
   * the turn's error and the exit message.
   */
  const exitSession = (sessionId: string, reason: ExitReason, message?: string): void => {
    const held = sessions.get(sessionId);
    // The process exit and a supervisor stop can both call this for the same
    // session. Only the first reports the exit.
    if (held === undefined) return;
    sessions.delete(sessionId);
    // Delete the session's instructions file. pi read it at start, and a
    // resume writes it again. Without this, the home would keep one file for
    // every session ever started in this instance.
    const instructions = held.systemPromptFile;
    if (instructions !== undefined) attempt(() => rmSync(instructions, { force: true }));
    // A subagent never outlives its session. No event is made up for its
    // turn: the controller stops every running subagent when the session
    // exits (spec 06 section 13.2).
    endAllSubagents(held);
    // Nobody can answer an approval on a session that is gone. Cancel it
    // instead of denying it, because nobody decided.
    cancelParksOf(held, held.root);
    // The turn and its items end with pi. An item left running would show a
    // spinner for as long as anyone looks at the session. A stop marks the
    // turn interrupted; a pi that exited by itself mid-turn marks it failed,
    // with its stderr as the error.
    for (const event of endTurn(
      held.root.state,
      held.stopping
        ? { state: "interrupted" }
        : {
            state: "failed",
            ...(message === undefined || message === "" ? {} : { error: message }),
          },
    )) {
      emit(event);
    }
    emit({
      _tag: "session.exited",
      eventId: crypto.randomUUID(),
      sessionId,
      at: now(),
      reason,
      ...(message === undefined || message === "" ? {} : { message: truncateMessage(message) }),
    });
  };

  /**
   * Closes every subagent's pi without reporting anything about their turns,
   * for a session that is ending, and reports each one's Token Usage so far.
   * Their open approvals are cancelled, because those cards could never be
   * answered.
   */
  const endAllSubagents = (held: Held): void => {
    for (const subagent of held.subagents.values()) {
      cancelParksOf(held, subagent);
      // The subagent's record keeps what it spent so far. Its turn gets no
      // event, but its Token Usage is known, not made up.
      for (const event of buildUsageEvents(subagent.state)) emit(event);
      closeProcess(subagent.child);
    }
    held.subagents.clear();
  };

  /**
   * Re-prompts the turn to call `submit_result`, inside the turn already open.
   * It sends pi's `prompt` command directly instead of a session input, because
   * an input would show up in the transcript as a message the user never wrote.
   */
  const askAgain = (held: Held, agent: RunningAgent): void => {
    const state = agent.state;
    state.reprompts += 1;
    Effect.runFork(
      Effect.catch(agent.rpc.send({ type: "prompt", message: REPROMPT }), (error) =>
        Effect.sync(() => {
          // Nothing will end this turn now, so end it here. A turn left open
          // would make the session look busy forever.
          warn(held.binding.sessionId, `could not ask pi again for an answer: ${error}`);
          for (const event of endTurn(state)) emit(event);
        }),
      ),
    );
  };

  /**
   * Ends a turn whose answers pi keeps rejecting. The turn keeps its last
   * answer, so it ends with a result that reports the schema failure instead
   * of looping on the validator forever.
   */
  const stopAsking = (held: Held, agent: RunningAgent): void => {
    warn(
      held.binding.sessionId,
      `pi rejected ${String(MAX_REFUSED_ANSWERS)} calls to ${SUBMIT_RESULT_TOOL} because their arguments do not match this session's output schema, so the turn was ended after the last one`,
    );
    Effect.runFork(abortTurn(agent, "schema"));
  };

  /**
   * Checks whether `agent` is still one of `held`'s running agents. Lines from
   * a pi the adapter has already let go of are ignored.
   */
  const isRunning = (held: Held, agent: RunningAgent): boolean =>
    sessions.get(held.binding.sessionId) === held &&
    (!isSubagent(agent) || held.subagents.get(agent.subagentId) === agent);

  /**
   * Handles one line of an agent's pi stdout that is not a response to a
   * command. A dialog is handled here. Anything else goes to the normalizer,
   * which turns it into the session's events.
   *
   * When an agent's turn ends, so does every subagent it started that is
   * still running: a call that no longer waits for a reply leaves its
   * subagent with nobody to work for. A subagent's own turn ending ends the
   * subagent, and its last message goes to its parent as the reply.
   */
  const onLine = (held: Held, agent: RunningAgent, line: string, frame: unknown): void => {
    if (!isRunning(held, agent)) return;
    // When the turn still owes an answer, pi settling does not end the turn.
    // The normalizer never sees this settle, so the turn stays open while the
    // runner re-prompts.
    if (announcesAgentSettled(frame) && owesAnswer(agent.state)) {
      askAgain(held, agent);
      return;
    }
    const dialog = parseDialog(frame);
    // A dialog is not an event about what pi did, so the normalizer never
    // sees it.
    if (dialog?.kind === "approval") {
      openPark(held, agent, dialog);
      return;
    }
    if (dialog?.kind === "subagent") {
      startSubagent(held, agent, dialog);
      return;
    }
    let completed: Extract<ProviderEvent, { _tag: "turn.completed" }> | undefined;
    for (const event of normalize(agent.state, line, frame)) {
      // A `subagent` call normally ends after its subagent replied. One that
      // ends first, because its turn was aborted, no longer waits for the
      // subagent, so the subagent stops with nobody to answer.
      if (event._tag === "item.completed" && event.kind === "subagent") {
        for (const subagent of listStartedBy(held, agent)) {
          if (subagent.toolCallItemId === event.itemId) {
            endSubagent(held, subagent, { state: "interrupted" }, undefined);
          }
        }
      }
      if (event._tag === "turn.completed") {
        completed = event;
        // pi no longer holds the call once the turn ends, so an approval card
        // left open could never be answered.
        cancelParksOf(held, agent);
        endSubagentsStartedBy(held, agent);
      }
      emit(event);
    }
    if (completed !== undefined && isSubagent(agent)) {
      endSubagent(
        held,
        agent,
        { state: completed.state },
        buildSubagentReply(completed.state, agent.state.lastAssistantText, completed.error),
      );
      return;
    }
    if (
      agent.state.refusedAnswers >= MAX_REFUSED_ANSWERS &&
      agent.state.endedBySystem === undefined
    ) {
      stopAsking(held, agent);
    }
  };

  /**
   * Watches an agent's pi process: keeps its last stderr lines, and reports
   * them when pi exits by itself. The session's own pi exiting ends the
   * session; a subagent's pi exiting ends that subagent, and its parent gets
   * the error as the reply.
   */
  const watchChild = (held: Held, agent: RunningAgent): void => {
    const child = agent.child;
    const complaints: Array<string> = [];
    const drained = (async () => {
      try {
        for await (const line of child.stderr) {
          if (line.trim() === "") continue;
          complaints.push(line);
          if (complaints.length > MAX_COMPLAINT_LINES) complaints.shift();
        }
      } catch {
        // A child killed while being read has no more output, and the lines
        // already read are still worth reporting.
      }
    })();
    const onChildGone = async (code: number | undefined): Promise<void> => {
      // `stopSession` waits for this exit and reports its own reason. A pi
      // that exited by itself has nobody else to report it.
      if (held.stopping) return;
      // pi's last stderr lines can still be in the pipe when the exit arrives.
      // Wait for them, so a crash is reported with its reason.
      await drained;
      const message = code === 0 ? "" : complaints.join("\n");
      if (!isSubagent(agent)) {
        exitSession(held.binding.sessionId, "process_exit", message);
        return;
      }
      const error = message === "" ? "its pi process exited" : message;
      endSubagent(
        held,
        agent,
        { state: "failed", error },
        { error: `The subagent failed: ${error}` },
      );
    };
    void child.exited.then(onChildGone, () => onChildGone(undefined));
  };

  /**
   * Writes a file pi reads, atomically: the content goes to a temporary file
   * beside `path`, which is then renamed to `path`. Throws when the write
   * fails. Without this, a pi starting in this home at the same moment could
   * read a half-written file: a session with no approval hook, or with half
   * its instructions.
   */
  const writeFileAtomically = (path: string, content: string): void => {
    const written = `${path}.${process.pid}.${crypto.randomUUID()}`;
    try {
      writeFileSync(written, content, { mode: 0o600 });
      renameSync(written, path);
    } catch (error) {
      // A failed write can happen, but a partial temporary file with a unique
      // name would never be cleaned up, so delete it.
      rmSync(written, { force: true });
      throw error;
    }
  };

  /**
   * Prepares the instance's home for a session: creates the sessions
   * directory and writes the extension and the session's instructions. Throws
   * when a write fails.
   */
  const prepareHome = (ctx: ProviderRunnerContext, sessionId: string, spec: SessionSpec): void => {
    mkdirSync(buildSessionsDir(ctx.home), { recursive: true, mode: 0o700 });
    // Written at every start, not once, so each session runs this build's
    // approval hook.
    writeFileAtomically(buildExtensionPath(ctx.home), EXTENSION_SOURCE);
    if (spec.systemPrompt !== undefined) {
      writeFileAtomically(buildSystemPromptPath(ctx.home, sessionId), spec.systemPrompt);
    }
  };

  const buildEnv = (
    ctx: ProviderRunnerContext,
    extra: Readonly<Record<string, string | undefined>> = {},
  ): Record<string, string | undefined> => {
    const key = ctx.secrets[ZAI_KEY.secret];
    const env: Record<string, string | undefined> = {
      ...ctx.env,
      PI_CODING_AGENT_DIR: ctx.home,
      // A pi that updated itself would run a version nobody chose, and the
      // check is a network request from a machine that may have no network.
      PI_SKIP_VERSION_CHECK: "1",
      ...extra,
    };
    // An extra variable given as undefined is removed, even when the
    // runner's own environment sets it.
    for (const [name, value] of Object.entries(extra)) if (value === undefined) delete env[name];
    // Use the instance's key or no key at all. The runner's own environment
    // may contain a key, and an instance with no key entered would then run on
    // that key and report itself as logged in.
    if (key === undefined || key === "") delete env[ZAI_KEY.variable];
    else env[ZAI_KEY.variable] = key;
    return env;
  };

  /**
   * Builds the environment of one agent's pi process: the instance's own, plus
   * what the extension reads. Every agent gets the session's access mode, and
   * the `subagent` tool unless it runs at `MAX_SUBAGENT_DEPTH`. Only the
   * session's own agent gets the output schema, because only it answers with
   * one.
   */
  const buildAgentEnv = (
    ctx: ProviderRunnerContext,
    spec: SessionSpec,
    depth: number,
  ): Record<string, string | undefined> =>
    buildEnv(ctx, {
      [ACCESS_MODE_VARIABLE]: spec.accessMode,
      // Both variables are given even when they do not apply, as undefined,
      // so `buildEnv` removes them. A runner started from inside a pi session
      // would otherwise pass that session's values on.
      [SUBAGENTS_VARIABLE]: depth < MAX_SUBAGENT_DEPTH ? "1" : undefined,
      // The schema goes in the environment, not the command line, so the
      // arguments stay exactly as this adapter built them, whatever the schema
      // contains.
      [OUTPUT_SCHEMA_VARIABLE]:
        spec.outputSchema === undefined || depth > 0
          ? undefined
          : JSON.stringify(spec.outputSchema),
    });

  const probe = makeProbe(seam.spawn, seam.run);

  const getHostedSession = (sessionId: string): Effect.Effect<Held, string> =>
    Effect.suspend(() => {
      const held = sessions.get(sessionId);
      return held === undefined
        ? Effect.fail(`session ${sessionId} is not running here`)
        : Effect.succeed(held);
    });

  /**
   * Sets the model and its thinking level before the prompt that uses them.
   * pi takes each as a separate command. Fails when pi rejects either one, and
   * the input then fails too: prompting anyway would run the turn on the model
   * the user meant to replace.
   */
  const selectModel = (
    held: Held,
    selection: ModelSelection,
    generation: number,
  ): Effect.Effect<void, string> =>
    Effect.gen(function* () {
      const root = held.root;
      yield* root.rpc.send({ type: "set_model", provider: ZAI, modelId: selection.model });
      // Record the model now, not after the level: pi has already switched
      // model, and if pi then rejected the level, turns would report the old
      // model.
      root.state.model = selection.model;
      held.modelSelection = { ...held.modelSelection, model: selection.model };
      if (held.inputGeneration !== generation || held.stopping)
        return yield* Effect.fail("the input was stopped before delivery");
      yield* root.rpc.send({
        type: "set_thinking_level",
        level: getSessionThinkingLevel(selection),
      });
      held.modelSelection = selection;
    });

  return {
    providerId: PI,
    binaryName: PI_BINARY,

    events: Stream.fromPubSub(published),

    // The pi plugin's config holds the Z.ai key as a secret, which reaches the
    // adapter in the context. The adapter uses nothing else from that config.
    probe: (ctx: ProviderRunnerContext): Effect.Effect<ProbeResult> =>
      ctx.binary === undefined
        ? Effect.succeed(buildFailedProbe(null, `no ${PI_BINARY} on this machine`))
        : probe(ctx.binary, buildEnv(ctx)),

    startSession: (sessionId, spec, ctx) =>
      Effect.gen(function* () {
        const binary = ctx.binary;
        if (binary === undefined) return yield* Effect.fail(`no ${PI_BINARY} on this machine`);
        // The entry stays until its pi has exited, so this session's pi is
        // still running. A second pi under the same id would write the same
        // transcript and leave the first one orphaned.
        if (sessions.has(sessionId)) {
          return yield* Effect.fail(`session ${sessionId} is still running here`);
        }
        const carried = spec.continue;
        const transcript =
          carried === undefined ? undefined : findTranscript(ctx.home, carried.nativeSessionId);
        if (carried !== undefined && transcript === undefined) {
          // Launching without it would start an empty session under the
          // resumed session's id: the conversation would silently lose its
          // history.
          return yield* Effect.fail(
            `the transcript of session ${carried.nativeSessionId} is no longer on this runner`,
          );
        }
        // Compute the path before the launch, because `prepareHome` below
        // writes the file, and the file must be deleted whether the session
        // ends or never starts.
        const instructions =
          spec.systemPrompt === undefined ? undefined : buildSystemPromptPath(ctx.home, sessionId);
        const child = yield* Effect.try({
          try: () => {
            prepareHome(ctx, sessionId, spec);
            return seam.spawn(
              [
                binary,
                ...buildArgv(spec, ctx, spec.modelSelection, {
                  kind: "session",
                  sessionId,
                  transcript,
                }),
              ],
              buildAgentEnv(ctx, spec, 0),
              // The session's working directory. pi resolves every relative
              // path against the directory it starts in, so a child that
              // inherited the runner's directory would write the user's work
              // into whatever directory the runner was started from.
              ctx.cwd,
            );
          },
          catch: (error) => {
            // A pi that never started has no session to end, and ending the
            // session is what deletes this file. So delete it here, or the
            // instructions of every failed launch would stay in the home.
            if (instructions !== undefined) attempt(() => rmSync(instructions, { force: true }));
            return error instanceof Error ? error.message : String(error);
          },
        });
        // A resumed session continues the native session. A fork is a new
        // native session, created under this session's id.
        const nativeSessionId = carried?.mode === "resume" ? carried.nativeSessionId : sessionId;
        const state = buildNormalizingState(sessionId, nativeSessionId, spec.outputSchema);
        state.model = spec.modelSelection.model;
        const binding: SessionBinding = { sessionId, nativeSessionId, instanceId: spec.instanceId };
        const root: RunningAgent = {
          child,
          rpc: makeRpc(child, (line, frame) => onLine(held, root, line, frame)),
          state,
          depth: 0,
        };
        const held: Held = {
          binding,
          spec,
          ctx,
          binary,
          root,
          subagents: new Map(),
          parks: new Map(),
          modelSelection: spec.modelSelection,
          systemPromptFile: instructions,
          stopping: false,
          inputGeneration: 0,
        };
        sessions.set(sessionId, held);
        watchChild(held, root);
        Effect.runFork(root.rpc.pump);
        // The native id goes on this event because the controller has no
        // other way to learn it: a session started after the runner's hello
        // is not listed again.
        emit({
          _tag: "session.started",
          eventId: crypto.randomUUID(),
          sessionId,
          at: now(),
          providerRefs: { nativeSessionId },
        });
        return binding;
      }),

    sendInput: (sessionId: string, input: TurnInput): Effect.Effect<SendResult, string> =>
      Effect.gen(function* () {
        const held = yield* getHostedSession(sessionId);
        const generation = held.inputGeneration;
        if (input.modelSelection !== undefined)
          yield* selectModel(held, input.modelSelection, generation);
        if (held.inputGeneration !== generation || held.stopping)
          return yield* Effect.fail("the input was stopped before delivery");
        // A turn is in flight exactly while the state holds its id. An input
        // during a turn steers it, instead of opening a second turn and
        // leaving the first one with nothing to end it.
        const root = held.root;
        const steered = root.state.turnId !== undefined;
        // Create the id before sending, not after: pi's `agent_start` can
        // arrive before its response to the prompt, and the normalizer uses
        // whatever turn id the state holds at that moment.
        const turnId = (root.state.turnId ??= crypto.randomUUID());
        yield* Effect.tapError(
          root.rpc.send({ type: steered ? "steer" : "prompt", message: input.text }),
          () =>
            // A prompt pi rejected opened no turn. Leaving its id would make
            // the next input steer a turn that never started.
            Effect.sync(() => {
              if (!steered) root.state.turnId = undefined;
            }),
        );
        // A successful prompt reply acknowledges delivery even when Stop
        // raced it. Abort again if that reply accepted work after the first
        // abort; never let the delayed acceptance restart the stopped turn.
        if (held.inputGeneration !== generation && root.state.turnId === turnId && !held.stopping)
          yield* abortTurn(root, "interrupt");
        for (const event of buildUserMessage({
          sessionId,
          turnId,
          text: input.text,
          steered,
          providerRefs: { nativeSessionId: held.binding.nativeSessionId },
        })) {
          emit(event);
        }
        return { turnId, delivery: steered ? "steered" : "opened" };
      }),

    interrupt: (sessionId: string, subagentId?: SubagentId): Effect.Effect<void> =>
      Effect.suspend(() => {
        const held = sessions.get(sessionId);
        if (held === undefined) return Effect.void;
        if (subagentId !== undefined) {
          // Stops that subagent and every subagent below it. Its parent keeps
          // working, with the stop as the call's result. A subagent that
          // already ended has nothing left to stop.
          const subagent = held.subagents.get(subagentId);
          if (subagent !== undefined) {
            endSubagent(held, subagent, { state: "interrupted" }, STOPPED_BY_USER);
          }
          return Effect.void;
        }
        held.inputGeneration += 1;
        // Stop all work in the session: every subagent, then the session's
        // own turn. The subagents get no reply, because the abort below also
        // ends the calls waiting for them.
        endSubagentsStartedBy(held, held.root);
        // Cancel the open approvals first. Nobody denied the calls; their
        // turn was stopped. An approval hook still waiting for an answer would
        // keep the turn open through the abort meant to end it.
        cancelParksOf(held, held.root);
        // The `turn.completed` event reports the interrupt; nothing else does.
        return held.root.state.turnId === undefined
          ? Effect.void
          : abortTurn(held.root, "interrupt");
      }),

    respondToApprovalRequest: (
      sessionId: string,
      requestId: string,
      decision: ApprovalDecision,
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        const held = sessions.get(sessionId);
        const park = held?.parks.get(requestId);
        // The approval was already answered, or its session is gone: there is
        // nothing left to decide.
        if (held === undefined || park === undefined) return Effect.void;
        resolvePark(held, park, decision);
        // A cancel blocks the call and also ends the turn of the agent that
        // asked, and only that agent's. pi treats a blocked call as one tool
        // it may not run, and would otherwise carry on with the rest of its
        // plan.
        return decision === "cancel" ? abortTurn(park.agent, "interrupt") : Effect.void;
      }),

    // pi parks only on a confirm dialog, never on a question, so there is
    // never a question here to answer. The `subagent` tool's input dialog is
    // answered by the runner itself and never reaches the user.
    respondToQuestion: (): Effect.Effect<void> => Effect.void,

    stopSession: (sessionId: string, reason: ExitReason): Effect.Effect<void> =>
      Effect.gen(function* () {
        const held = sessions.get(sessionId);
        // pi already exited, and that exit already ended this session.
        if (held === undefined) return;
        held.stopping = true;
        // The subagents hold the instance's key too, and keep no transcript,
        // so they are closed first and not waited for.
        endAllSubagents(held);
        const child = held.root.child;
        // Closing stdin tells pi to exit. Killing it outright would skip the
        // transcript flush that makes the session resumable. If the pipe is
        // already broken, pi is already exiting.
        attempt(() => child.end());
        const leaving = Effect.timeoutOption(
          Effect.promise(() => child.exited),
          STOP_DEADLINE,
        );
        if (Option.isSome(yield* leaving)) {
          exitSession(sessionId, reason);
          return;
        }
        // pi did not exit, so kill it: nothing else will make it exit, and it
        // holds the instance's key for as long as it runs.
        attempt(() => child.kill());
        // Wait for the exit, because the session entry is what stops a second
        // pi from starting on this transcript. Removing it while the first pi
        // is still writing would put two processes on one file.
        if (Option.isNone(yield* leaving)) {
          warn(
            sessionId,
            `pi did not stop within ${Duration.format(Duration.times(STOP_DEADLINE, 2))} of being asked, and may still be running`,
          );
        }
        exitSession(sessionId, reason);
      }),

    listSessions: Effect.sync(() => [...sessions.values()].map((held) => held.binding)),

    install: makePiInstall(seam.run),
  };
};

export const pi: ProviderAdapter = makePiAdapter({ spawn: spawnPi, run: runProcess });
