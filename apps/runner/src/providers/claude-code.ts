/**
 * The one file that imports the vendor SDK. The probe runs with no prompt and
 * asks the control protocol instead: a prompt that yields would bill the user's
 * account for opening a Fleet page. It touches only the instance's config
 * directory, never the user's `~/.claude`.
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
import { CLAUDE_CODE_VERSION } from "@hydra/home/version";
import {
  MAX_FACT_ITEMS,
  type AccessMode,
  type ApprovalDecision,
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
} from "@hydra/protocol";
import {
  normalize,
  normalizing,
  openTurn,
  toolKind,
  type Normalizing,
} from "./claude-code-normalize";
import type { ProviderAdapter, ProviderRunnerContext } from "./index";
import { installing } from "./install";
import { PROBE_DEADLINE, probeFailed } from "./probe";
import type { LoginCommand } from "./login";
import { runProcess, type Run } from "./process";
import { fact, text } from "./text";
import { userMessage } from "./events";
import { questionRequest } from "./questions";
import { now } from "../report";

export const CLAUDE_CODE = "claude-code";

const CLAUDE_BINARY = "claude";

/**
 * How long a control request is given. It is a write to the harness child and a
 * wait for its answer, and the runner handles session frames in the order they
 * arrived rather than concurrently, so one child that stops answering would
 * otherwise hold up every session on the machine - pings included.
 */
export const CONTROL_DEADLINE: Duration.Duration = Duration.seconds(5);

export interface ClaudeSession {
  readonly accountInfo: () => Promise<unknown>;
  readonly supportedModels: () => Promise<ReadonlyArray<unknown>>;
  /** Ends the query. The CLI is a child process, and it does not exit on its own. */
  readonly close: () => void;
}

/**
 * One long-lived streaming `query()`: the messages it yields, and the way to
 * end it. Its input is the stream the adapter pushes turns into, which is what
 * makes the control methods and steering available at all (spec 06 section 10.1).
 */
export interface ClaudeStream extends AsyncIterable<SDKMessage> {
  /** Ends the turn that is running; the session stays up for the next one. */
  readonly interrupt: () => Promise<void>;
  /** Takes effect on the next turn this session opens (spec 06 section 10.1). */
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
}

interface Model {
  readonly value: string;
  readonly displayName: string;
  readonly supportsEffort?: boolean;
  readonly supportedEffortLevels?: ReadonlyArray<string>;
  readonly supportsFastMode?: boolean;
}

const SEMVER = /\d+\.\d+\.\d+\S*/;

/** The effort level the CLI starts on when nothing chose one. */
const DEFAULT_EFFORT = "medium";

/** `Fact` refuses an empty string, and an `Error` can carry an empty message. */
const describe = (error: unknown): string => {
  const said = fact(error instanceof Error ? error.message : String(error));
  return said === "" ? "the harness failed without saying why" : said;
};

/** Only ever called with levels the CLI listed, or with the overlay's own. */
function effortOver([first, ...rest]: readonly [string, ...ReadonlyArray<string>]): ModelOption {
  const levels = [first, ...rest];
  return {
    id: "effort",
    label: "Effort",
    kind: "select",
    choices: levels.map((level) => ({
      value: fact(level),
      label: fact(`${level.slice(0, 1).toUpperCase()}${level.slice(1)}`),
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
 * Models the CLI no longer lists but still forwards to the API. Options are
 * hand-authored because no row describes them any more.
 */
const LEGACY_MODELS: ReadonlyArray<ModelDescriptor> = [
  {
    slug: "claude-opus-4-8",
    name: "Opus 4.8",
    isLegacy: true,
    options: [effortOver(["low", "medium", "high"])],
  },
  {
    slug: "claude-fable-5",
    name: "Fable 5",
    isLegacy: true,
    options: [effortOver(["low", "medium", "high"])],
  },
];

/** Adaptive thinking is a property of the model, not a choice, so it is no option. */
const descriptorOf = (model: Model): ModelDescriptor => {
  const options: Array<ModelOption> = [];
  const levels = model.supportedEffortLevels ?? [];
  const [first, ...rest] = levels;
  if (model.supportsEffort === true && first !== undefined) {
    options.push(effortOver([first, ...rest]));
  }
  if (model.supportsFastMode === true) options.push(FAST_MODE);
  return {
    slug: fact(model.value),
    name: fact(model.displayName),
    ...(model.value === "default" ? { isDefault: true } : {}),
    options,
  };
};

/**
 * A probed row wins over the overlay: it is what this machine will really offer.
 * Cut to what the protocol carries, or the whole report fails to encode.
 */
const catalogOf = (models: ReadonlyArray<Model>): ReadonlyArray<ModelDescriptor> => {
  // The protocol will not carry an empty slug or name.
  const probed = models
    .filter((model) => model.value !== "" && model.displayName !== "")
    .map(descriptorOf);
  const listed = new Set(probed.map((model) => model.slug));
  return [...probed, ...LEGACY_MODELS.filter((model) => !listed.has(model.slug))].slice(
    0,
    MAX_FACT_ITEMS,
  );
};

const authOf = (account: Account): ProbeResult["auth"] =>
  account.email === undefined
    ? { status: "unauthenticated" }
    : {
        status: "ok",
        identity: fact(account.email),
        ...(account.subscriptionType === undefined
          ? {}
          : { planLabel: fact(account.subscriptionType) }),
        ...(account.apiProvider === undefined ? {} : { backend: fact(account.apiProvider) }),
      };

/** `HOME` is left alone: overriding it makes the CLI report another account's login. */
const envFor = (ctx: ProviderRunnerContext): Record<string, string | undefined> => ({
  ...ctx.env,
  CLAUDE_CONFIG_DIR: ctx.home,
  // A probe that let the harness update itself would install a version nobody
  // chose in the middle of answering a question about versions.
  DISABLE_AUTOUPDATER: "1",
});

/**
 * The user's own settings and MCP servers stay out of a run that only reads two
 * facts. The CLI writes into the config directory regardless, which is why that
 * directory is the instance's own.
 */
const optionsFor = (ctx: ProviderRunnerContext, binary: string): Options => ({
  pathToClaudeCodeExecutable: binary,
  settingSources: [],
  strictMcpConfig: true,
  persistSession: false,
  env: envFor(ctx),
});

/** The prompt the SDK insists on, yielding nothing, so the run costs nothing. */
const noPrompt = (): AsyncIterable<never> => ({
  [Symbol.asyncIterator]: () => ({
    next: () => Promise.resolve({ done: true, value: undefined as never }),
  }),
});

/**
 * The input side of a live session: an async iterable the adapter pushes turns
 * into and closes when the session ends. The SDK's `query()` takes the prompt
 * as an iterable, so this is what makes a session long-lived rather than one
 * shot (spec 06 section 10.1).
 */
interface Pushable<A> extends AsyncIterable<A> {
  readonly push: (value: A) => void;
  readonly end: () => void;
}

const pushable = <A>(): Pushable<A> => {
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
 * Spec 06 section 8.1, normative. `approval-required` is the SDK's default
 * mode, whose park-and-resume seam is `canUseTool`. The callback is supplied in
 * every mode but `full-access`: which actions a mode asks about is the
 * harness's own judgement, and a mode that asks about nothing simply never
 * calls back.
 */
const PERMISSION_MODES: Readonly<Record<AccessMode, PermissionMode>> = {
  "approval-required": "default",
  "auto-accept-edits": "acceptEdits",
  auto: "auto",
  "full-access": "bypassPermissions",
};

/**
 * Which tools a read is asked about. The command and file-change families come
 * off the item kind the normalizer already gives a tool, so the two never
 * disagree; reading has no item kind of its own to read it from.
 */
const FILE_READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep"]);

/**
 * The input fields a tool names a path in. A tool may name none of them - a
 * `Glob` without a directory searches the workspace - so an empty list is an
 * honest answer, not a failure to look.
 */
const PATH_KEYS: ReadonlyArray<string> = ["file_path", "notebook_path", "path"];

const pathsIn = (input: Record<string, unknown>): ReadonlyArray<string> =>
  PATH_KEYS.flatMap((key) => {
    const found = input[key];
    return typeof found === "string" && found !== "" ? [fact(found)] : [];
  });

/**
 * One tool call turned into the question a user answers. Every field is cut to
 * what the protocol carries: an over-long command or path would be a frame
 * nobody can decode, which loses the event and leaves the park hanging.
 */
const requestFor = (
  requestId: string,
  itemId: string,
  toolName: string,
  input: Record<string, unknown>,
  canPersist: boolean,
): OpenRequest => {
  if (toolName === "AskUserQuestion") {
    return questionRequest({ requestId, itemId }, toolName, input["questions"]);
  }
  // `allow always` is offered only where the harness handed over rules to
  // persist: a button that would have to invent one grants more than the user
  // clicked, and an empty set has nothing in it to persist anyway.
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
  const kind = toolKind(toolName);
  const command = input["command"];
  // A command the harness did not name has nothing for a command card to show.
  if (kind === "command_execution" && typeof command === "string") {
    return { ...common, kind: "command_approval", detail: { command: text(command) } };
  }
  if (kind === "file_change") {
    return { ...common, kind: "file_change_approval", detail: { paths: pathsIn(input) } };
  }
  if (FILE_READ_TOOLS.has(toolName)) {
    return { ...common, kind: "file_read_approval", detail: { paths: pathsIn(input) } };
  }
  return { ...common, kind: "tool_approval", detail: { toolName: fact(toolName) } };
};

/** What the model is told when the user refuses; the vendor requires a reason. */
const REFUSED = "the user did not allow this";

const CANCELLED = "the user cancelled this turn";

/**
 * A decision in the vendor's own terms. `interrupt` is what makes a cancel more
 * than a deny: the turn ends with it rather than the model trying something
 * else. `decisionClassification` is how the harness reports who decided, and
 * a persisted rule is the harness's own suggestion handed straight back.
 */
const resultFor = (
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

/** The one per-model choice the SDK's options carry; `fastMode` has no field. */
const effortIn = (options: SessionSpec["modelSelection"]["options"]): EffortLevel | undefined => {
  const chosen = options["effort"];
  return EFFORTS.find((level) => level === chosen);
};

/**
 * A session, unlike a probe, runs the user's work: it gets the workspace as its
 * cwd and the instance's home as its config directory. Auto memory is off and
 * `settingSources` is empty because a Hydra session's context is Hydra's to
 * author, never whatever files happen to sit on this runner (spec 06 section 4.2,
 * section 10.1).
 */
const sessionOptionsFor = (
  ctx: ProviderRunnerContext,
  spec: SessionSpec,
  binary: string,
  native: Options,
  canUseTool: CanUseTool,
): Options => {
  const effort = effortIn(spec.modelSelection.options);
  return {
    pathToClaudeCodeExecutable: binary,
    ...native,
    ...(ctx.cwd === null ? {} : { cwd: ctx.cwd }),
    settingSources: [],
    strictMcpConfig: true,
    includePartialMessages: true,
    model: spec.modelSelection.model,
    ...(effort === undefined ? {} : { effort }),
    permissionMode: PERMISSION_MODES[spec.accessMode],
    // Every mode but the one that asks about nothing: with permissions skipped
    // the SDK ignores the callback and warns once per session about it.
    ...(spec.accessMode === "full-access"
      ? { allowDangerouslySkipPermissions: true }
      : { canUseTool }),
    env: { ...envFor(ctx), CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
  };
};

/**
 * Which native session a start lands on, and what the CLI has to be told to get
 * there. A resume continues the parent's own session, so there is nothing to
 * name. A fork and a fresh start are named by Hydra rather than by the harness:
 * in streaming-input mode the CLI says nothing at all, `init` included, until a
 * first turn arrives, so a binding that waited for it would make `startSession`
 * block until somebody sent input.
 */
const nativeSessionFor = (
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
 * The question this adapter is holding an answer open for. The promise the
 * harness is waiting on is inside the closure; all anyone else needs is its
 * id, the answers it takes, and the way to end the wait.
 */
interface Park {
  readonly requestId: string;
  readonly decisions: ReadonlyArray<ApprovalDecision>;
  /** The harness is told the answer in its own terms and resumes. */
  readonly answer: (decision: ApprovalDecision) => void;
  /**
   * The question stops existing before anyone answered it: the turn was
   * interrupted, the session stopped, the harness withdrew the ask, or the
   * harness simply stopped talking. The stream reports it cancelled, because
   * nothing the user did refused it, and the harness is told a plain deny,
   * because there is no turn left to interrupt.
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
   * The question this session is parked on, if any. One at a time: a park
   * serializes the tool batch, and the surfaces show one card. On the entry
   * rather than beside it: a park is a promise inside the harness's own call,
   * so it must die with the session that is waiting on it.
   */
  park: Park | undefined;
  /** Set by `stopSession` to the reason it was given, so the exit says why. */
  stopping: ExitReason | undefined;
  /** The model the harness is running under, starting as the spec's. */
  model: string;
}

export const claudeCodeAdapter = (seam: ClaudeSeam): ProviderAdapter => {
  // Creating an unbounded PubSub allocates and nothing more, so it is safe to
  // run here and keeps `adapterFor` the synchronous lookup every other caller
  // already treats it as.
  const published = Effect.runSync(PubSub.unbounded<ProviderEvent>());
  const live = new Map<string, Live>();

  const emit = (event: ProviderEvent): void => {
    PubSub.publishUnsafe(published, event);
  };

  /**
   * One control request, bounded. Answers with why it did not go through, or
   * `undefined` where it did.
   */
  const controlling = (request: Promise<void>): Effect.Effect<string | undefined> =>
    Effect.map(
      Effect.timeoutOption(
        Effect.match(Effect.tryPromise({ try: () => request, catch: describe }), {
          onFailure: (why: string) => why,
          onSuccess: () => undefined,
        }),
        CONTROL_DEADLINE,
      ),
      Option.getOrElse(() => `it did not answer within ${Duration.format(CONTROL_DEADLINE)}`),
    );

  /**
   * The seam the harness asks through (spec 06 section 8.2). The promise
   * returned here is the park: it stays open until an answer arrives, until the
   * harness withdraws the question by aborting the signal, or until the session
   * goes. Held by the session's own entry, under the id the adapter mints,
   * which is the id every answer comes back under.
   */
  const asking =
    (sessionId: string): CanUseTool =>
    (toolName, input, options) =>
      new Promise<PermissionResult>((settle) => {
        const held = live.get(sessionId);
        // Fail closed, on the same test that refuses input: with no entry, or
        // one on its way out, nobody is left to answer and the park would hold
        // the harness for ever.
        if (held === undefined || held.stopping !== undefined) {
          settle(resultFor("deny", []));
          return;
        }
        // Withdrawn before it was ever asked: the turn is already being
        // interrupted, so there is nothing to put in front of the user.
        if (options.signal.aborted) {
          settle(resultFor("deny", []));
          return;
        }
        // One at a time. A second question while one is held would replace the
        // card the user is looking at, so the harness is told to wait instead.
        if (held.park !== undefined) {
          settle({
            behavior: "deny",
            message:
              "another approval is still waiting for the user; ask again after it is answered",
            decisionClassification: "user_reject",
          });
          return;
        }
        // An "allow always" is an answer about this thread, not about the
        // user's machine: whatever the harness offered to persist is rewritten
        // to the session so no click here edits a settings file on disk.
        const persists = (options.suggestions ?? []).map((rule) => ({
          ...rule,
          destination: "session" as const,
        }));
        const requestId = crypto.randomUUID();
        // A park belongs to a turn: it is what the turn is waiting on, and the
        // supervisor pauses the inactivity clock of an open turn for it. The
        // SDK can ask before the assistant message that opened the turn has
        // been read off its stream, so the turn is opened here where there is
        // none yet.
        const { events } = openTurn(held.state);
        for (const event of events) emit(event);
        const request = requestFor(
          requestId,
          // An id the protocol will not carry is a frame nobody can decode,
          // which would lose the event and leave a park nothing can see.
          options.toolUseID === "" ? held.state.mint() : fact(options.toolUseID),
          toolName,
          input,
          persists.length > 0,
        );
        const end = (decision: ApprovalDecision, told: PermissionResult): void => {
          // The park is this session's only one, and only while it is still
          // this one: a second answer has nothing left to end.
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
        // Every way this question can stop existing without an answer, in one
        // place: the harness's own withdrawal, an interrupt, a stop, and the
        // harness reaching the end of its stream.
        const withdraw = (): void => end("cancel", resultFor("deny", []));
        options.signal.addEventListener("abort", withdraw, { once: true });
        held.park = {
          requestId,
          decisions: request.decisions,
          answer: (decision) => end(decision, resultFor(decision, persists)),
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

  /** The session this adapter is hosting, refusing one already on its way out. */
  const hosting = (sessionId: string): Effect.Effect<Live, string> =>
    Effect.suspend(() => {
      const held = live.get(sessionId);
      return held === undefined || held.stopping !== undefined
        ? Effect.fail(`session ${sessionId} is not running here`)
        : Effect.succeed(held);
    });

  /** Reads the session until the harness stops talking, and says why it did. */
  const pump = async (sessionId: string, held: Live): Promise<void> => {
    let reason: ExitReason = "process_exit";
    try {
      for await (const sdk of held.stream) {
        for (const event of normalize(held.state, sdk)) emit(event);
      }
    } catch (error) {
      reason = "crash";
      // Ending the query rejects whatever was in flight, and an ordinary stop
      // is not something to report as a runtime error.
      if (held.stopping === undefined) {
        emit({
          _tag: "runtime.error",
          eventId: crypto.randomUUID(),
          sessionId,
          at: now(),
          class: "unknown",
          message: describe(error),
        });
      }
    } finally {
      // The one place every exit passes through, and before the exit is
      // reported: a park left hanging is a promise the harness waits on for
      // ever, and one still reading as open on a session that is gone leaves a
      // card nothing can answer.
      held.park?.withdraw();
      // By identity: a session started again under the same id has its own
      // entry, and this pump is not the one that owns it.
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

  const versionOf = (ctx: ProviderRunnerContext, binary: string): Effect.Effect<string | null> =>
    Effect.map(seam.run([binary, "--version"], envFor(ctx)), (ran) => {
      if (ran.code !== 0) return null;
      // An unrecognisable version goes raw; an empty one the protocol will not carry.
      const printed = fact(SEMVER.exec(ran.stdout)?.[0] ?? ran.stdout.trim());
      return printed === "" ? null : printed;
    });

  const ask = (
    ctx: ProviderRunnerContext,
    binary: string,
  ): Effect.Effect<{ account: Account; models: ReadonlyArray<Model> }, string> =>
    Effect.acquireUseRelease(
      Effect.sync(() => seam.query({ options: optionsFor(ctx, binary) })),
      (session) =>
        Effect.gen(function* () {
          const account = yield* Effect.tryPromise({
            try: () => session.accountInfo(),
            catch: describe,
          });
          const models = yield* Effect.tryPromise({
            try: () => session.supportedModels(),
            catch: describe,
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
        // Two harnesses under one Hydra session id would report their events,
        // and their exit, as each other's. The second start is the mistake.
        if (live.has(sessionId)) {
          return Effect.fail(`session ${sessionId} is already running here`);
        }
        const native = nativeSessionFor(spec);
        const binding: SessionBinding = {
          sessionId,
          nativeSessionId: native.nativeSessionId,
          instanceId: spec.instanceId,
        };
        const input = pushable<SDKUserMessage>();
        return Effect.map(
          Effect.try({
            try: () =>
              seam.stream({
                options: sessionOptionsFor(ctx, spec, binary, native.options, asking(sessionId)),
                input,
              }),
            catch: describe,
          }),
          (stream) => {
            const held: Live = {
              binding,
              input,
              stream,
              state: normalizing(sessionId, () => crypto.randomUUID(), now),
              park: undefined,
              stopping: undefined,
              model: spec.modelSelection.model,
            };
            live.set(sessionId, held);
            void pump(sessionId, held);
            // The native id rides the event, because the controller has no
            // other way to learn it: `sessionsReport` is sent once, at hello,
            // and a session started after that would never be named again.
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
        const before = yield* hosting(sessionId);
        // A model change lands only where a turn is about to open: mid-turn the
        // harness is already answering under the model it started with. Asked
        // only where it differs from what was last applied, so a session with
        // no change to make never waits on the harness for one. A model the
        // harness will not take fails the input: delivering it under the old
        // one would answer for a turn the caller did not ask for.
        if (model !== undefined && model !== before.model && before.state.turnId === undefined) {
          const refused = yield* controlling(before.stream.setModel(model));
          if (refused !== undefined) {
            return yield* Effect.fail(`the model was not changed to ${model}: ${refused}`);
          }
          before.model = model;
        }
        // Asked again, because `setModel` waits on the harness and the turn may
        // have opened, ended or the whole session gone while it did.
        const held = yield* hosting(sessionId);
        const { turnId, events } = openTurn(held.state);
        for (const event of events) emit(event);
        // Steering is implicit: a turn the adapter did not have to open is a
        // turn already running, so the input folds into it. Read off what
        // `openTurn` just did rather than remembered from before the wait.
        const steered = events.length === 0;
        for (const event of userMessage({ sessionId, turnId, text: turn.text, steered })) {
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
        // Nothing to end, so nothing is asked of the harness: a control request
        // waits on it, and this frame is handled in the connection's own order.
        if (held === undefined || held.state.turnId === undefined) return Effect.void;
        // Before the harness is asked, not after: the CLI withdraws a pending
        // question once the turn is interrupted, and a request still reading as
        // open when the turn closes leaves a card on screen for a turn that is
        // over.
        held.park?.withdraw();
        // The turn completing as `interrupted` is the whole report; a refusal
        // means the harness is already gone, which is the same outcome.
        return Effect.asVoid(controlling(held.stream.interrupt()));
      }),

    stopSession: (sessionId: string, reason: ExitReason): Effect.Effect<void> =>
      Effect.sync(() => {
        const held = live.get(sessionId);
        // Idempotent, and the first reason wins: a second stop (a timer racing
        // an explicit one, say) is the harness already on its way out, and the
        // exit should say why that first ask was made, not why the second one
        // was.
        if (held === undefined || held.stopping !== undefined) return;
        // The entry stays until the pump winds up, so `live` remains the one
        // register of what this adapter holds and a start under the same id is
        // refused while the old harness is still going. `stopping` is what
        // refuses input in the meantime, and what the exit event's reason
        // comes from.
        held.stopping = reason;
        // The park is not ended here: closing the stream winds the pump up,
        // and its `finally` is where every exit ends one.
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
        // The request said which answers it takes, and it is the authority on
        // that here too: an answer it did not offer is one the harness would
        // have to substitute for.
        if (!park.decisions.includes(decision)) return;
        park.answer(decision);
      }),

    listSessions: Effect.sync(() => [...live.values()].map((held) => held.binding)),

    // Every shipped provider's config schema is empty, so the Claude adapter
    // takes nothing from it and does not name the argument.
    probe: (ctx: ProviderRunnerContext): Effect.Effect<ProbeResult> => {
      const binary = ctx.binary;
      if (binary === undefined) {
        return Effect.succeed(probeFailed(null, `no ${CLAUDE_BINARY} on this machine`));
      }
      const gather = Effect.gen(function* () {
        const harnessVersion = yield* versionOf(ctx, binary);
        return yield* Effect.match(ask(ctx, binary), {
          onFailure: (message) => probeFailed(harnessVersion, message),
          onSuccess: ({ account, models }) => ({
            harnessVersion,
            auth: authOf(account),
            models: catalogOf(models),
          }),
        });
      });
      return Effect.map(
        Effect.timeoutOption(gather, PROBE_DEADLINE),
        Option.getOrElse(() =>
          probeFailed(null, `the harness did not answer within ${Duration.format(PROBE_DEADLINE)}`),
        ),
      );
    },

    /**
     * `BROWSER` fails on purpose: a successful launch makes the CLI switch to a
     * `localhost` callback, which a browser on another machine cannot reach.
     */
    login: (ctx: ProviderRunnerContext, binary: string): LoginCommand => ({
      command: [binary, "auth", "login"],
      env: { ...envFor(ctx), BROWSER: "false" },
    }),

    /**
     * Pinned to the CLI this build's SDK talks to. The script needs the network
     * even so.
     */
    install: installing(seam.run, [
      "bash",
      "-c",
      `curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_CODE_VERSION}`,
    ]),
  };
};

export const claudeCode: ProviderAdapter = claudeCodeAdapter({
  stream: ({ options, input }) => {
    const running: Query = sdkQuery({ prompt: input, options });
    return {
      [Symbol.asyncIterator]: () => running[Symbol.asyncIterator](),
      interrupt: () => running.interrupt().then(() => undefined),
      setModel: (model) => running.setModel(model),
      close: () => {
        // The child may already be gone, and the rejection would take the
        // daemon down over one session ending.
        running.return(undefined).catch(() => undefined);
      },
    };
  },
  query: ({ options }) => {
    const session: Query = sdkQuery({ prompt: noPrompt(), options });
    return {
      accountInfo: () => session.accountInfo(),
      supportedModels: () => session.supportedModels(),
      close: () => {
        // The child is usually already gone when close runs, and the rejection
        // would take the daemon down over one bad probe.
        session.return(undefined).catch(() => undefined);
      },
    };
  },
  run: runProcess,
});
