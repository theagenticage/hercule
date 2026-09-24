/**
 * The pi adapter. It runs one pi process per session and talks to it in pi's
 * RPC mode. Everything the process reads or writes lives under the instance's
 * own agent directory. If pi used the developer's own directory, Hercule's
 * sessions would mix with the user's login, skills and settings.
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
  TurnInput,
} from "@hercule/protocol";
import type { ProviderAdapter, ProviderRunnerContext } from "../index";
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
  SUBMIT_RESULT_TOOL,
} from "./extension";
import {
  endTurn,
  normalize,
  buildNormalizingState,
  type Normalizing,
  type RunningTool,
} from "./normalize";
import { DEFAULT_THINKING, makePiInstall, makeProbe, ZAI } from "./probe";
import { makeRpc, type PiChild, type PiRpc, type PiSpawn } from "./rpc";

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
 * An approval the session is parked on. `request` is what every surface shows
 * and answers. `dialogId` is pi's own id for the dialog: pi reads only that id
 * and a value back, so the answer is sent under it.
 */
interface Park {
  readonly request: OpenRequest;
  readonly dialogId: string;
  /** pi's id for the held tool call, used to recognise the call when it ends. */
  readonly toolCallId: string;
}

/**
 * The prompt the runner sends when a turn finishes without calling
 * `submit_result`. It is one fixed sentence, because it ends up in the
 * transcript of every session with an output schema that needs it.
 */
export const REPROMPT = `You must call ${SUBMIT_RESULT_TOOL} with your answer; do nothing else.`;

/**
 * How many times the runner re-prompts one turn before it reports that the
 * turn gave no answer. More re-prompts would risk a session that never ends.
 * This is the "default 2 retries" of the pi row in spec 06 section 7.
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
 * This is the second of the two limits in the pi row of spec 06 section 7.
 * `MAX_REPROMPTS` above is the first.
 */
const MAX_REFUSED_ANSWERS = 3;

/** A session this adapter hosts, and the adapter's state for its pi process. */
interface Held {
  readonly binding: SessionBinding;
  readonly child: PiChild;
  readonly rpc: PiRpc;
  readonly state: Normalizing;
  /**
   * The file the session's instructions were written to, if it has any.
   * Nothing reads the file after the session's pi is gone, so it is deleted
   * with the session instead of piling up in the instance's home.
   */
  readonly systemPromptFile: string | undefined;
  /** Whether `stopSession` is stopping this session. The stop then reports the exit. */
  stopping: boolean;
  /** The approval this session is parked on, if any. There is at most one at a time. */
  park: Park | undefined;
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

/** A pi approval dialog that holds a tool call, and the id of that call. */
interface Dialog {
  readonly id: string;
  readonly toolCallId: string;
}

/**
 * Parses the dialog message the approval hook wrote, which is JSON naming the
 * held call. Returns an empty object when the message is not a JSON object.
 */
const parseHeldCall = (message: unknown): Record<string, unknown> => {
  if (typeof message !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(message);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Only Hercule's approval hook opens dialogs in these sessions, so a
    // message in any other shape names no call. The adapter denies a dialog
    // about no call instead of showing it to the user.
    return {};
  }
};

const readString = (record: Record<string, unknown>, key: string): string =>
  typeof record[key] === "string" ? record[key] : "";

/**
 * Parses a frame as a pi approval dialog. Returns undefined for any other
 * frame. Only `confirm` requests count: pi also sends notifications and status
 * updates as requests, and those need no response.
 */
const parseDialog = (frame: unknown): Dialog | undefined => {
  if (typeof frame !== "object" || frame === null) return undefined;
  const asked = frame as Record<string, unknown>;
  const id = asked["id"];
  if (
    asked["type"] !== "extension_ui_request" ||
    asked["method"] !== "confirm" ||
    typeof id !== "string"
  ) {
    return undefined;
  }
  return { id, toolCallId: readString(parseHeldCall(asked["message"]), "toolCallId") };
};

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
 * Builds pi's command-line arguments for a session. A new session gets
 * Hercule's session id with `--session-id`. A resume passes the transcript with
 * `--session` instead: pi rejects the two together, because the transcript
 * already has its own session id.
 */
const buildArgv = (
  spec: SessionSpec,
  ctx: ProviderRunnerContext,
  sessionId: string,
  transcript: string | undefined,
): ReadonlyArray<string> => {
  const resuming = spec.continue?.mode === "resume" && transcript !== undefined;
  const excluded = (spec.disallowedTools ?? []).flatMap((family) => PI_TOOLS_BY_FAMILY[family]);
  return [
    "--mode",
    "rpc",
    // Load nothing of the user's own: a Hercule session runs only on what the
    // controller configured for it, not on whatever this machine has installed.
    "--no-context-files",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    // Hercule handles approvals through the extension below. pi's own prompt
    // would appear on the JSON channel, where no person is reading it.
    "--no-approve",
    "--offline",
    "-e",
    buildExtensionPath(ctx.home),
    "--session-dir",
    buildSessionsDir(ctx.home),
    ...(resuming ? ["--session", transcript] : ["--session-id", sessionId]),
    ...(spec.continue?.mode === "fork" && transcript !== undefined ? ["--fork", transcript] : []),
    "--model",
    `${ZAI}/${spec.modelSelection.model}`,
    "--thinking",
    getSessionThinkingLevel(spec.modelSelection),
    // Added after pi's own system prompt, never replacing it, and passed as
    // the path `prepareHome` wrote it to, not as the text.
    ...(spec.systemPrompt === undefined
      ? []
      : ["--append-system-prompt", buildSystemPromptPath(ctx.home, sessionId)]),
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

  /** Tells pi what was decided about the call it is holding. */
  const sendDecision = (held: Held, dialogId: string, decision: ApprovalDecision): void => {
    attempt(() =>
      held.child.write(
        `${JSON.stringify({ type: "extension_ui_response", id: dialogId, ...buildDialogAnswer(decision) })}\n`,
      ),
    );
  };

  /**
   * Resolves the approval the session is parked on, if any. It sends the
   * decision to pi, so the held call runs or is blocked, and emits
   * `request.resolved`, so surfaces stop offering the card. Does nothing when
   * the session is not parked.
   */
  const resolvePark = (held: Held, decision: ApprovalDecision): void => {
    const park = held.park;
    if (park === undefined) return;
    held.park = undefined;
    // Mark the call as declined, so the transcript shows the user's decision
    // instead of a failed call.
    if (decision !== "allow") held.state.declined.add(park.toolCallId);
    sendDecision(held, park.dialogId, decision);
    emit({
      _tag: "request.resolved",
      eventId: crypto.randomUUID(),
      sessionId: held.binding.sessionId,
      at: now(),
      requestId: park.request.requestId,
      decision,
    });
  };

  /**
   * Aborts the turn pi is running. The `turn.completed` event reports the end.
   * The reason is recorded here in `endedBySystem` instead of read back from
   * pi, because pi reports an abort during a tool call as an error on the
   * message in flight, while the turn actually ended because the system asked.
   */
  const abortTurn = (
    held: Held,
    reason: NonNullable<Normalizing["endedBySystem"]>,
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      held.state.endedBySystem ??= reason;
      return Effect.ignore(held.rpc.send({ type: "abort" }));
    });

  /**
   * Handles a pi approval dialog: opens an approval request for the held call,
   * or denies the dialog at once when the session is already parked or the
   * call is unknown.
   */
  const openPark = (held: Held, dialog: Dialog): void => {
    const sessionId = held.binding.sessionId;
    if (held.park !== undefined) {
      sendDecision(held, dialog.id, "deny");
      warn(
        sessionId,
        "pi asked for a second approval while the first was still open. Hercule handles one approval at a time, so the second was denied; pi can ask again later.",
      );
      return;
    }
    const item = held.state.tools.get(dialog.toolCallId);
    if (item === undefined) {
      // The approval card is shown on the call it is about, and no such call
      // is running. Denying is the only way to avoid pi holding a call that
      // nobody will ever answer.
      sendDecision(held, dialog.id, "deny");
      warn(sessionId, "pi asked for approval of a tool call that is not running, so it was denied");
      return;
    }
    const request = buildOpenRequest(
      crypto.randomUUID(),
      item,
      APPROVALS[item.kind] ?? "tool_approval",
    );
    held.park = { request, dialogId: dialog.id, toolCallId: dialog.toolCallId };
    emit({
      _tag: "request.opened",
      eventId: crypto.randomUUID(),
      sessionId,
      at: now(),
      request,
    });
  };

  /**
   * Ends a session, whichever way it ended: removes its entry, cancels its
   * open approval, ends its turn and emits `session.exited`. `message` is pi's
   * last stderr output; it becomes both the turn's error and the exit message.
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
    // Nobody can answer an approval on a session that is gone. Cancel it
    // instead of denying it, because nobody decided.
    resolvePark(held, "cancel");
    // The turn and its items end with pi. An item left running would show a
    // spinner for as long as anyone looks at the session. A stop marks the
    // turn interrupted; a pi that exited by itself mid-turn marks it failed,
    // with its stderr as the error.
    for (const event of endTurn(
      held.state,
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
   * Re-prompts the turn to call `submit_result`, inside the turn already open.
   * It sends pi's `prompt` command directly instead of a session input, because
   * an input would show up in the transcript as a message the user never wrote.
   */
  const askAgain = (held: Held): void => {
    held.state.reprompts += 1;
    Effect.runFork(
      Effect.catch(held.rpc.send({ type: "prompt", message: REPROMPT }), (error) =>
        Effect.sync(() => {
          // Nothing will end this turn now, so end it here. A turn left open
          // would make the session look busy forever.
          warn(held.binding.sessionId, `could not ask pi again for an answer: ${error}`);
          for (const event of endTurn(held.state)) emit(event);
        }),
      ),
    );
  };

  /**
   * Ends a turn whose answers pi keeps rejecting. The turn keeps its last
   * answer, so it ends with a result that reports the schema failure instead
   * of looping on the validator forever.
   */
  const stopAsking = (held: Held): void => {
    warn(
      held.binding.sessionId,
      `pi rejected ${String(MAX_REFUSED_ANSWERS)} calls to ${SUBMIT_RESULT_TOOL} because their arguments do not match this session's output schema, so the turn was ended after the last one`,
    );
    Effect.runFork(abortTurn(held, "schema"));
  };

  /**
   * Handles one line of pi's stdout that is not a response to a command. An
   * approval dialog is handled here. Anything else goes to the normalizer,
   * which turns it into the session's events.
   */
  const onLine = (sessionId: string, line: string, frame: unknown): void => {
    const held = sessions.get(sessionId);
    if (held === undefined) return;
    // When the turn still owes an answer, pi settling does not end the turn.
    // The normalizer never sees this settle, so the turn stays open while the
    // runner re-prompts.
    if (announcesAgentSettled(frame) && owesAnswer(held.state)) {
      askAgain(held);
      return;
    }
    const dialog = parseDialog(frame);
    // A dialog is not an event about what pi did, so the normalizer never
    // sees it.
    if (dialog !== undefined) {
      openPark(held, dialog);
      return;
    }
    for (const event of normalize(held.state, line, frame)) {
      if (event._tag === "turn.completed") {
        // pi no longer holds the call once the turn ends, so an approval card
        // left open could never be answered.
        resolvePark(held, "cancel");
      }
      emit(event);
    }
    if (
      held.state.refusedAnswers >= MAX_REFUSED_ANSWERS &&
      held.state.endedBySystem === undefined
    ) {
      stopAsking(held);
    }
  };

  /**
   * Watches the child process: keeps its last stderr lines, and ends the
   * session with them when pi exits by itself.
   */
  const watchChild = (held: Held): void => {
    const child = held.child;
    const sessionId = held.binding.sessionId;
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
      exitSession(sessionId, "process_exit", code === 0 ? "" : complaints.join("\n"));
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
    extra: Readonly<Record<string, string>> = {},
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
    // Use the instance's key or no key at all. The runner's own environment
    // may contain a key, and an instance with no key entered would then run on
    // that key and report itself as logged in.
    if (key === undefined || key === "") delete env[ZAI_KEY.variable];
    else env[ZAI_KEY.variable] = key;
    return env;
  };

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
  const selectModel = (held: Held, selection: ModelSelection): Effect.Effect<void, string> =>
    Effect.gen(function* () {
      yield* held.rpc.send({ type: "set_model", provider: ZAI, modelId: selection.model });
      // Record the model now, not after the level: pi has already switched
      // model, and if pi then rejected the level, turns would report the old
      // model.
      held.state.model = selection.model;
      yield* held.rpc.send({
        type: "set_thinking_level",
        level: getSessionThinkingLevel(selection),
      });
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
              [binary, ...buildArgv(spec, ctx, sessionId, transcript)],
              buildEnv(ctx, {
                [ACCESS_MODE_VARIABLE]: spec.accessMode,
                // The schema goes in the environment, not the command line,
                // so the arguments stay exactly as this adapter built them,
                // whatever the schema contains.
                ...(spec.outputSchema === undefined
                  ? {}
                  : { [OUTPUT_SCHEMA_VARIABLE]: JSON.stringify(spec.outputSchema) }),
              }),
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
        const rpc = makeRpc(child, (line, frame) => onLine(sessionId, line, frame));
        const binding: SessionBinding = { sessionId, nativeSessionId, instanceId: spec.instanceId };
        const held: Held = {
          binding,
          child,
          rpc,
          state,
          systemPromptFile: instructions,
          stopping: false,
          park: undefined,
        };
        sessions.set(sessionId, held);
        watchChild(held);
        Effect.runFork(rpc.pump);
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
        if (input.modelSelection !== undefined) yield* selectModel(held, input.modelSelection);
        // A turn is in flight exactly while the state holds its id. An input
        // during a turn steers it, instead of opening a second turn and
        // leaving the first one with nothing to end it.
        const steered = held.state.turnId !== undefined;
        // Create the id before sending, not after: pi's `agent_start` can
        // arrive before its response to the prompt, and the normalizer uses
        // whatever turn id the state holds at that moment.
        const turnId = (held.state.turnId ??= crypto.randomUUID());
        yield* Effect.tapError(
          held.rpc.send({ type: steered ? "steer" : "prompt", message: input.text }),
          () =>
            // A prompt pi rejected opened no turn. Leaving its id would make
            // the next input steer a turn that never started.
            Effect.sync(() => {
              if (!steered) held.state.turnId = undefined;
            }),
        );
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

    interrupt: (sessionId: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        const held = sessions.get(sessionId);
        if (held === undefined) return Effect.void;
        // Cancel the open approval first. Nobody denied the call; its turn was
        // stopped. An approval hook still waiting for an answer would keep the
        // turn open through the abort meant to end it.
        resolvePark(held, "cancel");
        // The `turn.completed` event reports the interrupt; nothing else does.
        return held.state.turnId === undefined ? Effect.void : abortTurn(held, "interrupt");
      }),

    respondToRequest: (
      sessionId: string,
      requestId: string,
      decision: ApprovalDecision,
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        const held = sessions.get(sessionId);
        const park = held?.park;
        // The approval was already answered, or its session is gone: there is
        // nothing left to decide.
        if (held === undefined || park === undefined || park.request.requestId !== requestId) {
          return Effect.void;
        }
        resolvePark(held, decision);
        // A cancel blocks the call and also ends the turn. pi treats a blocked
        // call as one tool it may not run, and would otherwise carry on with
        // the rest of its plan.
        return decision === "cancel" ? abortTurn(held, "interrupt") : Effect.void;
      }),

    stopSession: (sessionId: string, reason: ExitReason): Effect.Effect<void> =>
      Effect.gen(function* () {
        const held = sessions.get(sessionId);
        // pi already exited, and that exit already ended this session.
        if (held === undefined) return;
        held.stopping = true;
        // Closing stdin tells pi to exit. Killing it outright would skip the
        // transcript flush that makes the session resumable. If the pipe is
        // already broken, pi is already exiting.
        attempt(() => held.child.end());
        const leaving = Effect.timeoutOption(
          Effect.promise(() => held.child.exited),
          STOP_DEADLINE,
        );
        if (Option.isSome(yield* leaving)) {
          exitSession(sessionId, reason);
          return;
        }
        // pi did not exit, so kill it: nothing else will make it exit, and it
        // holds the instance's key for as long as it runs.
        attempt(() => held.child.kill());
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
