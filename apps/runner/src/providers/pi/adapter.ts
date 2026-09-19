/**
 * The pi adapter. One pi process per session, spoken to over its RPC mode, and
 * everything that process touches lives under the instance's own agent
 * directory: a runner that let pi read the developer's own would mix Hydra's
 * sessions with the user's login, skills and settings.
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
} from "@hydra/protocol";
import type { ProviderAdapter, ProviderRunnerContext } from "../index";
import { userMessage } from "../events";
import { probeFailed } from "../probe";
import { runProcess, spawnPi, type Run } from "../process";
import { fact, text } from "../text";
import { now } from "../../report";
import {
  ACCESS_MODE_VARIABLE,
  EXTENSION_FILE,
  EXTENSION_SOURCE,
  OUTPUT_SCHEMA_VARIABLE,
  SUBMIT_RESULT_TOOL,
} from "./extension";
import { ending, normalize, normalizing, type Normalizing, type RunningTool } from "./normalize";
import { DEFAULT_THINKING, piInstall, probing, ZAI } from "./probe";
import { rpcOver, type PiChild, type PiRpc, type PiSpawn } from "./rpc";

export const PI = "pi";

const PI_BINARY = "pi";

/**
 * The Z.ai credential, as Hydra's instance config names it and as pi reads it.
 * The runner cannot import the pi plugin, so the adapter owns the mapping the
 * way the Claude adapter owns `CLAUDE_CONFIG_DIR`.
 */
const ZAI_KEY = { secret: "zaiApiKey", variable: "ZAI_API_KEY" };

/** What pi wrote on its way out, kept for the report when it dies. */
const MAX_COMPLAINT_LINES = 5;

/**
 * How long a stopped pi is given to leave on its own. Closing its stdin is the
 * cue it leaves on, a question it is holding included; a pi that does not take
 * that cue would go on running with the user's key in it while Hydra believes
 * the session is over.
 */
const STOP_DEADLINE: Duration.Duration = Duration.seconds(2);

/**
 * What a held call is asked as on the session's stream, named from the
 * protocol's own list so a kind renamed there does not quietly become a second
 * vocabulary here.
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
 * The question the approval hook stopped a tool call on. pi identifies its dialogs by an
 * id of its own and reads nothing else back, so an answer is that id and a
 * value; the request is what every surface sees and answers by.
 */
interface Park {
  readonly request: OpenRequest;
  readonly dialogId: string;
  /** pi's own id for the held call, which is how its end is recognised. */
  readonly toolCallId: string;
}

/**
 * What a turn that settled without answering is asked again. Pinned rather
 * than phrased per call: it is the one sentence the model reads about what it
 * failed to do, and it goes into the transcript of every session under a
 * schema.
 */
export const REPROMPT = `You must call ${SUBMIT_RESULT_TOOL} with your answer; do nothing else.`;

/**
 * How often one turn is asked again before it is reported as having answered
 * nothing. A third would be a session nothing ever ends.
 */
const MAX_REPROMPTS = 2;

/**
 * How many answers pi may refuse before Hydra stops asking this turn for one.
 * pi validates a call against the schema it registered the tool under and
 * hands its complaint back to the model as the call's result, so a model that
 * cannot satisfy the schema answers that complaint for as long as it is let
 * to: a live session on a schema no value satisfies called the tool 84 times
 * in five minutes and was still going. A few tries absorb a model that merely
 * got it wrong; past them, the turn is over and its last answer is the verdict.
 */
const MAX_REFUSED_ANSWERS = 3;

/** One session this adapter hosts, and what it believes about its pi. */
interface Held {
  readonly binding: SessionBinding;
  readonly child: PiChild;
  readonly rpc: PiRpc;
  readonly state: Normalizing;
  /** Whether this session is being stopped, whose end is reported by the stop. */
  stopping: boolean;
  /** The question this session is parked on, if any: one at a time. */
  park: Park | undefined;
}

/**
 * The answers a held call takes. The approval hook could remember a rule for the rest
 * of the session, which is not built here, so an "allow always" is not offered
 * rather than being quietly narrowed to this one call.
 */
const DECISIONS: readonly [ApprovalDecision, ...ReadonlyArray<ApprovalDecision>] = [
  "allow",
  "deny",
  "cancel",
];

/** What pi reads each answer as: no decision made, or yes, or no. */
const answerFor = (decision: ApprovalDecision): Record<string, unknown> =>
  decision === "cancel" ? { cancelled: true } : { confirmed: decision === "allow" };

/**
 * What a held call is asked as, from what the normalizer already made of it:
 * a command, a change to a file, or a tool by name. The tools each mode holds
 * are the policy's business; what the question is called follows from the item
 * the card overlays.
 */
const APPROVALS: Readonly<Partial<Record<ItemKind, ParkKind>>> = {
  command_execution: "command_approval",
  file_change: "file_change_approval",
};

/** A string argument pi's tool was called with. */
const stringArg = (item: RunningTool, name: string): string => {
  const value = item.args?.[name];
  return typeof value === "string" ? value : "";
};

/**
 * The card the user answers. What it shows comes from the call pi started,
 * not from the question: pi's own dialog carries no more than which call it is
 * about, and a surface renders the command, the path or the tool's name.
 */
const requestFor = (requestId: string, item: RunningTool, kind: ParkKind): OpenRequest => {
  const common = { requestId, itemId: item.itemId, decisions: DECISIONS };
  if (kind === "command_approval") {
    return { ...common, kind, detail: { command: text(stringArg(item, "command")) } };
  }
  if (kind === "file_change_approval") {
    return { ...common, kind, detail: { paths: [fact(stringArg(item, "path"))] } };
  }
  return { ...common, kind, detail: { toolName: fact(item.toolName) } };
};

/** One question pi is holding a tool call on, and the call it is about. */
interface Dialog {
  readonly id: string;
  readonly toolCallId: string;
}

/** What the approval hook wrote in the dialog: the call it is asking about. */
const parseHeldCall = (message: unknown): Record<string, unknown> => {
  if (typeof message !== "string") return {};
  try {
    const said: unknown = JSON.parse(message);
    return typeof said === "object" && said !== null ? (said as Record<string, unknown>) : {};
  } catch {
    // Only Hydra's own approval hook asks anything in these sessions, so a message in
    // any other shape names no call - and a question about no call is one the
    // reader below refuses rather than docks.
    return {};
  }
};

const stringIn = (record: Record<string, unknown>, key: string): string =>
  typeof record[key] === "string" ? record[key] : "";

/**
 * The dialog pi is waiting on, if this frame is one. `confirm` alone: pi sends
 * its notifications and status updates as requests too, and they are told
 * nothing back.
 */
const dialogOf = (frame: unknown): Dialog | undefined => {
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
  return { id, toolCallId: stringIn(parseHeldCall(asked["message"]), "toolCallId") };
};

/** Whether this frame is pi saying it has no more turns of its own to run. */
const announcesAgentSettled = (frame: unknown): boolean =>
  typeof frame === "object" &&
  frame !== null &&
  (frame as { readonly type?: unknown }).type === "agent_settled";

/**
 * Whether a settle is one the turn is asked again on: a session that was asked
 * for a value, a turn still in flight, no answer yet, and asking left.
 */
const owesAnswer = (state: Normalizing): boolean =>
  state.outputSchema !== undefined &&
  state.turnId !== undefined &&
  state.answer === undefined &&
  state.reprompts < MAX_REPROMPTS &&
  // A turn Hydra has ended is over: asking it again would be a question put to
  // a session the user just stopped, and a turn that never closes on it.
  state.endedByHydra === undefined &&
  // So is one that broke or was aborted on its way here: only a run that
  // reached its end had the chance to answer and did not take it.
  state.stopped.state === "completed";

/**
 * Every session's transcript sits in the instance's own directory, named for
 * the moment it started and the session it is.
 */
const sessionsDir = (home: string): string => join(home, "sessions");

const extensionPath = (home: string): string => join(home, EXTENSION_FILE);

/**
 * The Agent's instructions for one session, beside the extension. pi reads a
 * `--append-system-prompt` value that names a file it can open as that file's
 * contents and anything else as the text itself, so the prompt is handed over
 * as a path: instructions on the argv are instructions in the machine's
 * process list, and a prompt that reads like a filename - `AGENTS.md` - would
 * otherwise become whatever that file happens to say.
 */
const systemPromptPath = (home: string, sessionId: string): string =>
  join(home, `system-prompt-${sessionId}.txt`);

const getSessionThinkingLevel = (selection: ModelSelection): string => {
  const picked = selection.options["thinking"];
  return typeof picked === "string" && picked !== "" ? picked : DEFAULT_THINKING;
};

/**
 * The transcript of a native session, by its id. pi resolves a bare id against
 * the sessions recorded for the current directory and asks on stdin - Hydra's
 * own JSON channel - when it has to look wider, so a path is what it is given.
 */
const transcriptOf = (home: string, nativeSessionId: string): string | undefined => {
  let names: ReadonlyArray<string>;
  try {
    names = readdirSync(sessionsDir(home));
  } catch {
    return undefined;
  }
  const found = names.find((name) => name.endsWith(`_${nativeSessionId}.jsonl`));
  return found === undefined ? undefined : join(sessionsDir(home), found);
};

/**
 * Which of pi 0.85.1's own tools each family the spec names is. The two web
 * families map to nothing: pi has no web tool, and a name it does not know is
 * a flag it refuses to start on.
 */
const PI_TOOLS: Readonly<Record<DisallowedTool, ReadonlyArray<string>>> = {
  edit: ["edit"],
  write: ["write"],
  shell: ["bash"],
  "web-search": [],
  "web-fetch": [],
};

/**
 * The launch. `--session-id` names the session Hydra's own id, and a resume
 * takes the transcript instead: pi refuses the two together, because the
 * session the transcript is already carries its own id.
 */
const argvFor = (
  spec: SessionSpec,
  ctx: ProviderRunnerContext,
  sessionId: string,
  transcript: string | undefined,
): ReadonlyArray<string> => {
  const resuming = spec.continue?.mode === "resume" && transcript !== undefined;
  const excluded = (spec.disallowedTools ?? []).flatMap((family) => PI_TOOLS[family]);
  return [
    "--mode",
    "rpc",
    // Nothing of the user's own: a Hydra session runs on what the controller
    // authored for it and on nothing this machine happens to have lying about.
    "--no-context-files",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    // Approvals are Hydra's own, through the extension below; pi's own prompt
    // would be asked on the JSON channel nobody is reading as a terminal.
    "--no-approve",
    "--offline",
    "-e",
    extensionPath(ctx.home),
    "--session-dir",
    sessionsDir(ctx.home),
    ...(resuming ? ["--session", transcript] : ["--session-id", sessionId]),
    ...(spec.continue?.mode === "fork" && transcript !== undefined ? ["--fork", transcript] : []),
    "--model",
    `${ZAI}/${spec.modelSelection.model}`,
    "--thinking",
    getSessionThinkingLevel(spec.modelSelection),
    // Appended to pi's own prompt, never in place of it, and by the path
    // `prepare` wrote it to rather than as the text.
    ...(spec.systemPrompt === undefined
      ? []
      : ["--append-system-prompt", systemPromptPath(ctx.home, sessionId)]),
    // An empty value excludes nothing, and a flag with nothing after it is one
    // pi files as a flag it does not know: a list nobody asked for is left out
    // rather than sent as either.
    ...(excluded.length === 0 ? [] : ["--exclude-tools", excluded.join(",")]),
  ];
};

export const piAdapter = (seam: PiSeam): ProviderAdapter => {
  // Creating an unbounded PubSub allocates and nothing more, so it is safe to
  // run here and keeps `adapterFor` the synchronous lookup every other caller
  // already treats it as.
  const published = Effect.runSync(PubSub.unbounded<ProviderEvent>());
  const sessions = new Map<string, Held>();

  const emit = (event: ProviderEvent): void => {
    PubSub.publishUnsafe(published, event);
  };

  /** Something the session's reader should hear, that is not its harness's. */
  const warn = (sessionId: string, message: string): void => {
    emit({
      _tag: "runtime.warning",
      eventId: crypto.randomUUID(),
      sessionId,
      at: now(),
      message: text(message),
    });
  };

  /**
   * A pipe that has already broken throws on every write and on the kill after
   * it, and a session that could not be ended is still a session that is over.
   */
  const attempt = (act: () => void): void => {
    try {
      act();
    } catch {
      // Nothing left to say to a child that is already gone.
    }
  };

  /** Tells pi what was decided about the call it is holding. */
  const tell = (held: Held, dialogId: string, decision: ApprovalDecision): void => {
    attempt(() =>
      held.child.write(
        `${JSON.stringify({ type: "extension_ui_response", id: dialogId, ...answerFor(decision) })}\n`,
      ),
    );
  };

  /**
   * Ends the park this session is on: pi is told, so the call it is holding
   * runs or is blocked, and the surfaces are told, so the card stops being
   * answerable. A session with no park has nothing to end.
   */
  const resolvePark = (held: Held, decision: ApprovalDecision): void => {
    const park = held.park;
    if (park === undefined) return;
    held.park = undefined;
    // What the transcript says the call ended as: a refusal is the user's own
    // answer, not something that went wrong with the call.
    if (decision !== "allow") held.state.declined.add(park.toolCallId);
    tell(held, park.dialogId, decision);
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
   * Ends the turn pi is running, whose completion on `events` reports it. Why
   * it was ended is held here rather than read back off pi: an abort that
   * lands while a tool is running comes back as an error on the message pi was
   * in the middle of, and this turn ended because Hydra asked it to.
   */
  const abort = (
    held: Held,
    reason: NonNullable<Normalizing["endedByHydra"]>,
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      held.state.endedByHydra ??= reason;
      return Effect.ignore(held.rpc.send({ type: "abort" }));
    });

  /** pi is asking about a tool call it is holding open until it is answered. */
  const openPark = (held: Held, dialog: Dialog): void => {
    const sessionId = held.binding.sessionId;
    if (held.park !== undefined) {
      tell(held, dialog.id, "deny");
      warn(
        sessionId,
        "pi asked a second thing while the first was still unanswered; Hydra asks one at a time, so this one was refused and can be asked again",
      );
      return;
    }
    const item = held.state.tools.get(dialog.toolCallId);
    if (item === undefined) {
      // A card overlays the call it is about, and there is no such call
      // running. Refusing is the only answer that does not leave pi holding a
      // call nothing will ever answer.
      tell(held, dialog.id, "deny");
      warn(sessionId, "pi asked about a tool call it is not running, so it was refused");
      return;
    }
    const request = requestFor(crypto.randomUUID(), item, APPROVALS[item.kind] ?? "tool_approval");
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
   * The one end of a session: its entry goes, its card goes, its turn ends and
   * the exit is reported. `message` is what pi complained about on its way
   * out, which is both why the turn failed and what the exit says.
   */
  const exit = (sessionId: string, reason: ExitReason, message?: string): void => {
    const held = sessions.get(sessionId);
    // A pi that left on its own and a supervisor that stopped it are one end,
    // and a second exit would be a second row for it.
    if (held === undefined) return;
    sessions.delete(sessionId);
    // A card left open on a session that is gone is one nothing can answer,
    // and nobody refused it: the session went.
    resolvePark(held, "cancel");
    // A turn whose pi is gone is over, and the items under it with it: a row
    // left running is one that spins for as long as the session is looked at.
    // How it ended is who ended it: a stop is the one the user asked for, and
    // a pi that went by itself mid-turn failed, with what it complained about.
    for (const event of ending(
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
      ...(message === undefined || message === "" ? {} : { message: text(message) }),
    });
  };

  /**
   * Asks the turn again for the tool it was meant to answer through, inside
   * the turn it already opened: sent as pi's own prompt command rather than as
   * an input, because Hydra asked nobody anything and a user message here
   * would be a sentence the user never wrote.
   */
  const askAgain = (held: Held): void => {
    held.state.reprompts += 1;
    Effect.runFork(
      Effect.catch(held.rpc.send({ type: "prompt", message: REPROMPT }), (error) =>
        Effect.sync(() => {
          // Nothing will settle this turn now, and a turn left open on it is a
          // session that reads as working for as long as anyone looks at it.
          warn(held.binding.sessionId, `pi refused to be asked again for an answer: ${error}`);
          for (const event of ending(held.state)) emit(event);
        }),
      ),
    );
  };

  /**
   * Stops asking this turn for an answer it cannot give. The last answer is
   * already the turn's, so ending the run here is what turns a model arguing
   * with the validator into a turn that says the schema was not satisfied.
   */
  const stopAsking = (held: Held): void => {
    warn(
      held.binding.sessionId,
      `pi refused ${String(MAX_REFUSED_ANSWERS)} answers to ${SUBMIT_RESULT_TOOL} because they do not satisfy this session's output schema; the turn was ended on the last of them`,
    );
    Effect.runFork(abort(held, "schema"));
  };

  /**
   * One line off pi's stdout that was not an answer to a command: a question
   * the approval hook is asking, which is answered here, or something pi did, which the
   * normalizer turns into the session's events.
   */
  const onLine = (sessionId: string, line: string, frame: unknown): void => {
    const held = sessions.get(sessionId);
    if (held === undefined) return;
    // A settle the turn still owes an answer on is not the end of that turn:
    // the whole episode is one Hydra turn, so the normalizer never hears this
    // settle and the turn stays open until the asking is done.
    if (announcesAgentSettled(frame) && owesAnswer(held.state)) {
      askAgain(held);
      return;
    }
    const dialog = dialogOf(frame);
    // A question is not a report of what pi did: it is answered here, and the
    // normalizer never sees it.
    if (dialog !== undefined) {
      openPark(held, dialog);
      return;
    }
    for (const event of normalize(held.state, line, frame)) {
      if (event._tag === "turn.completed") {
        // A turn that ended took its question with it: pi is no longer holding
        // the call, and a card left docked is one nothing can answer.
        resolvePark(held, "cancel");
      }
      emit(event);
    }
    if (held.state.refusedAnswers >= MAX_REFUSED_ANSWERS && held.state.endedByHydra === undefined) {
      stopAsking(held);
    }
  };

  /** What pi complained about on its way out, which is why it is kept. */
  const watch = (held: Held): void => {
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
        // A child killed mid-read has nothing more to complain about, and what
        // it already said is still worth reporting.
      }
    })();
    const gone = async (code: number | undefined): Promise<void> => {
      // A stop is waiting on this and reports the reason it was given; a pi
      // that left by itself has nobody else to say so.
      if (held.stopping) return;
      // What pi said on its way out can still be in the pipe when its exit
      // lands, and a crash reported without it is a session that died for no
      // stated reason.
      await drained;
      exit(sessionId, "process_exit", code === 0 ? "" : complaints.join("\n"));
    };
    void child.exited.then(gone, () => gone(undefined));
  };

  /**
   * One file pi reads, put in place whole: written beside the name it takes
   * and renamed over it, because a pi starting in this home at the same moment
   * would otherwise load whatever half of it had reached disk - a session with
   * no approval hook, or with half its instructions.
   */
  const putFile = (path: string, content: string): void => {
    const written = `${path}.${process.pid}.${crypto.randomUUID()}`;
    try {
      writeFileSync(written, content, { mode: 0o600 });
      renameSync(written, path);
    } catch (error) {
      // A home that could not be written is an ordinary state, but a partial
      // file left under a name nobody will reuse is litter in the user's home.
      rmSync(written, { force: true });
      throw error;
    }
  };

  /** The home pi keeps this instance's sessions and this session's files in. */
  const prepare = (ctx: ProviderRunnerContext, sessionId: string, spec: SessionSpec): void => {
    mkdirSync(sessionsDir(ctx.home), { recursive: true, mode: 0o700 });
    // Rewritten at every start rather than once, so the approval hook a session
    // runs behind is always this build's.
    putFile(extensionPath(ctx.home), EXTENSION_SOURCE);
    if (spec.systemPrompt !== undefined) {
      putFile(systemPromptPath(ctx.home, sessionId), spec.systemPrompt);
    }
  };

  const envFor = (
    ctx: ProviderRunnerContext,
    extra: Readonly<Record<string, string>> = {},
  ): Record<string, string | undefined> => {
    const key = ctx.secrets[ZAI_KEY.secret];
    const env: Record<string, string | undefined> = {
      ...ctx.env,
      PI_CODING_AGENT_DIR: ctx.home,
      // A harness that updated itself would run a version nobody chose, and
      // the check is a request out of a machine that may reach nothing.
      PI_SKIP_VERSION_CHECK: "1",
      ...extra,
    };
    // The instance's key or none: the runner daemon's own environment may
    // carry one, and an instance nobody has entered a key on would then run on
    // whatever that machine exports and report itself as logged in.
    if (key === undefined || key === "") delete env[ZAI_KEY.variable];
    else env[ZAI_KEY.variable] = key;
    return env;
  };

  const probe = probing(seam.spawn, seam.run);

  const hosting = (sessionId: string): Effect.Effect<Held, string> =>
    Effect.suspend(() => {
      const held = sessions.get(sessionId);
      return held === undefined
        ? Effect.fail(`session ${sessionId} is not running here`)
        : Effect.succeed(held);
    });

  /**
   * The model and its thinking level, applied before the prompt that runs on
   * them. pi takes both as commands of their own, so a refusal is the input's
   * refusal: prompting anyway would run the turn on the model the user
   * replaced.
   */
  const selecting = (held: Held, selection: ModelSelection): Effect.Effect<void, string> =>
    Effect.gen(function* () {
      yield* held.rpc.send({ type: "set_model", provider: ZAI, modelId: selection.model });
      // Set here rather than after the level: pi is already on this model, and
      // a level pi refuses would otherwise leave every turn reporting the old.
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

    // The pi plugin's config carries the Z.ai key as a secret, which reaches
    // the adapter on the context; nothing else in it is the adapter's.
    probe: (ctx: ProviderRunnerContext): Effect.Effect<ProbeResult> =>
      ctx.binary === undefined
        ? Effect.succeed(probeFailed(null, `no ${PI_BINARY} on this machine`))
        : probe(ctx.binary, envFor(ctx)),

    startSession: (sessionId, spec, ctx) =>
      Effect.gen(function* () {
        const binary = ctx.binary;
        if (binary === undefined) return yield* Effect.fail(`no ${PI_BINARY} on this machine`);
        // The entry lives until its pi is gone, so this is a session whose
        // harness is still running: a second one under the same id would write
        // its transcript and leave the first talking to nobody.
        if (sessions.has(sessionId)) {
          return yield* Effect.fail(`session ${sessionId} is still running here`);
        }
        const carried = spec.continue;
        const transcript =
          carried === undefined ? undefined : transcriptOf(ctx.home, carried.nativeSessionId);
        if (carried !== undefined && transcript === undefined) {
          // Launching without it would start a pi on an empty session under a
          // resumed session's id, which is a conversation that lost its past
          // with nothing said anywhere.
          return yield* Effect.fail(
            `the transcript of session ${carried.nativeSessionId} is no longer on this runner`,
          );
        }
        const child = yield* Effect.try({
          try: () => {
            prepare(ctx, sessionId, spec);
            return seam.spawn(
              [binary, ...argvFor(spec, ctx, sessionId, transcript)],
              envFor(ctx, {
                [ACCESS_MODE_VARIABLE]: spec.accessMode,
                // Out of the environment rather than the argv, so the launch
                // stays exactly what this adapter authored, whatever the
                // schema is.
                ...(spec.outputSchema === undefined
                  ? {}
                  : { [OUTPUT_SCHEMA_VARIABLE]: JSON.stringify(spec.outputSchema) }),
              }),
              // Where the session's own files go. pi resolves every relative
              // path against the directory it was started in, so a child that
              // inherited the runner's would write the user's work into
              // whatever directory the daemon was launched from.
              ctx.cwd,
            );
          },
          catch: (error) => (error instanceof Error ? error.message : String(error)),
        });
        // A resumed session carries on the native one; a fork is a session of
        // its own, minted under this session's id.
        const nativeSessionId = carried?.mode === "resume" ? carried.nativeSessionId : sessionId;
        const state = normalizing(sessionId, nativeSessionId, spec.outputSchema);
        state.model = spec.modelSelection.model;
        const rpc = rpcOver(child, (line, frame) => onLine(sessionId, line, frame));
        const binding: SessionBinding = { sessionId, nativeSessionId, instanceId: spec.instanceId };
        const held: Held = {
          binding,
          child,
          rpc,
          state,
          stopping: false,
          park: undefined,
        };
        sessions.set(sessionId, held);
        watch(held);
        Effect.runFork(rpc.pump);
        // The native id rides the event, because the controller has no other
        // way to learn it: a session started after hello is never named again.
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
        const held = yield* hosting(sessionId);
        if (input.modelSelection !== undefined) yield* selecting(held, input.modelSelection);
        // A turn is in flight exactly while the state holds its id, which is
        // what makes an input a steer: it folds into that turn rather than
        // opening a second one and leaving the first with nobody to end it.
        const steered = held.state.turnId !== undefined;
        // Minted before the send, not after it: pi's own `agent_start` can
        // land before the answer to the prompt does, and the normalizer files
        // it under whatever id the state is already holding.
        const turnId = (held.state.turnId ??= crypto.randomUUID());
        yield* Effect.tapError(
          held.rpc.send({ type: steered ? "steer" : "prompt", message: input.text }),
          () =>
            // A prompt pi refused opened no turn, and an id left behind for it
            // would make the next input a steer of a turn that never started.
            Effect.sync(() => {
              if (!steered) held.state.turnId = undefined;
            }),
        );
        for (const event of userMessage({
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
        // The question goes first, and before the turn is looked at: nobody
        // refused the call, the turn it belonged to was stopped, and an approval
        // hook still waiting on an answer would hold the turn open through the
        // abort that was meant to end it.
        resolvePark(held, "cancel");
        // The turn completing on `events` is the whole report.
        return held.state.turnId === undefined ? Effect.void : abort(held, "interrupt");
      }),

    respondToRequest: (
      sessionId: string,
      requestId: string,
      decision: ApprovalDecision,
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        const held = sessions.get(sessionId);
        const park = held?.park;
        // A question already answered, or one from a session that has since
        // gone, has nothing left to decide.
        if (held === undefined || park === undefined || park.request.requestId !== requestId) {
          return Effect.void;
        }
        resolvePark(held, decision);
        // A cancel refuses the call and ends the turn with it: pi reads a
        // refusal as one tool it may not run, and would carry on with the rest
        // of what it had planned.
        return decision === "cancel" ? abort(held, "interrupt") : Effect.void;
      }),

    stopSession: (sessionId: string, reason: ExitReason): Effect.Effect<void> =>
      Effect.gen(function* () {
        const held = sessions.get(sessionId);
        // A pi that already left has already exited this session.
        if (held === undefined) return;
        held.stopping = true;
        // Closing stdin is pi's own cue to leave: killing it outright would
        // lose the transcript flush that makes the session resumable. A pipe
        // that is already broken is a pi that is already leaving.
        attempt(() => held.child.end());
        const leaving = Effect.timeoutOption(
          Effect.promise(() => held.child.exited),
          STOP_DEADLINE,
        );
        if (Option.isSome(yield* leaving)) {
          exit(sessionId, reason);
          return;
        }
        // A pi that did not take the cue is killed: nothing further will make
        // it leave, and it holds the instance's key for as long as it runs.
        attempt(() => held.child.kill());
        // Waited on, because the entry is what refuses a second pi on this
        // session's transcript, and dropping it while the first is still
        // writing would put two of them on one file.
        if (Option.isNone(yield* leaving)) {
          warn(
            sessionId,
            `pi did not stop within ${Duration.format(Duration.times(STOP_DEADLINE, 2))} of being asked, and may still be running`,
          );
        }
        exit(sessionId, reason);
      }),

    listSessions: Effect.sync(() => [...sessions.values()].map((held) => held.binding)),

    install: piInstall(seam.run),
  };
};

export const pi: ProviderAdapter = piAdapter({ spawn: spawnPi, run: runProcess });
