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
  type EffortLevel,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_CODE_VERSION } from "@hydra/home/version";
import {
  MAX_FACT_ITEMS,
  MAX_FACT_LENGTH,
  MAX_INSTALL_MESSAGE_LENGTH,
  type AccessMode,
  type ExitReason,
  type ModelDescriptor,
  type ModelOption,
  type ProbeResult,
  type ProviderEvent,
  type SendResult,
  type SessionBinding,
  type SessionSpec,
  type TurnInput,
} from "@hydra/protocol";
import { normalize, normalizing, openTurn, type Normalizing } from "./claude-code-normalize";
import type { InstallOutcome, ProviderAdapter, ProviderRunnerContext } from "./index";
import type { LoginCommand } from "./login";
import { runProcess, type Run } from "./process";
import { now } from "../report";

export const CLAUDE_CODE = "claude-code";

const CLAUDE_BINARY = "claude";

/** Long enough for a cold CLI, short enough that a Fleet page does not look hung. */
export const PROBE_DEADLINE: Duration.Duration = Duration.seconds(15);

/** Downloading and running somebody else's installer over a slow link. */
export const INSTALL_DEADLINE: Duration.Duration = Duration.minutes(5);

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

/** Cut to what the protocol carries; one over-long value would fail the report. */
const fact = (value: string): string => value.slice(0, MAX_FACT_LENGTH);

/** `Fact` refuses an empty string, and an `Error` can carry an empty message. */
const describe = (error: unknown): string => {
  const said = fact(error instanceof Error ? error.message : String(error));
  return said === "" ? "the harness failed without saying why" : said;
};

const failed = (harnessVersion: string | null, message: string): ProbeResult => ({
  harnessVersion,
  auth: { status: "error", message },
  models: [],
});

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
 * Spec 06 section 8.1, normative. `approval-required` is the SDK's default mode, whose
 * park-and-resume seam is `canUseTool`; until approvals ship the CLI has no
 * prompt surface, so an action that would have asked is denied rather than
 * allowed. Refusing beats guessing.
 */
const PERMISSION_MODES: Readonly<Record<AccessMode, PermissionMode>> = {
  "approval-required": "default",
  "auto-accept-edits": "acceptEdits",
  auto: "auto",
  "full-access": "bypassPermissions",
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
    ...(spec.accessMode === "full-access" ? { allowDangerouslySkipPermissions: true } : {}),
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

/** One session this adapter is hosting. */
interface Live {
  readonly binding: SessionBinding;
  readonly input: Pushable<SDKUserMessage>;
  readonly stream: ClaudeStream;
  readonly state: Normalizing;
  /** Set by `stopSession`, so the exit reason says it was asked for. */
  stopping: boolean;
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

  /** The session this adapter is hosting, refusing one already on its way out. */
  const hosting = (sessionId: string): Effect.Effect<Live, string> =>
    Effect.suspend(() => {
      const held = live.get(sessionId);
      return held === undefined || held.stopping
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
      if (!held.stopping) {
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
      // By identity: a session started again under the same id has its own
      // entry, and this pump is not the one that owns it.
      if (live.get(sessionId) === held) live.delete(sessionId);
      emit({
        _tag: "session.exited",
        eventId: crypto.randomUUID(),
        sessionId,
        at: now(),
        reason: held.stopping ? "stopped" : reason,
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
                options: sessionOptionsFor(ctx, spec, binary, native.options),
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
              stopping: false,
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
        // The user message is reported here rather than off the harness's echo
        // of it, because only here is it known whether it steered: the echo
        // cannot say which input it echoes.
        const itemId = held.state.mint();
        const detail = { text: turn.text, ...(steered ? { steered: true } : {}) };
        const item = {
          sessionId,
          at: held.state.now(),
          turnId,
          itemId,
          kind: "user_message",
        } as const;
        emit({ _tag: "item.started", eventId: held.state.mint(), ...item, detail });
        emit({
          _tag: "item.completed",
          eventId: held.state.mint(),
          ...item,
          status: "completed",
          detail,
        });
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
        // The turn completing as `interrupted` is the whole report; a refusal
        // means the harness is already gone, which is the same outcome.
        return Effect.asVoid(controlling(held.stream.interrupt()));
      }),

    stopSession: (sessionId: string): Effect.Effect<void> =>
      Effect.sync(() => {
        const held = live.get(sessionId);
        if (held === undefined) return;
        // The entry stays until the pump winds up, so `live` remains the one
        // register of what this adapter holds and a start under the same id is
        // refused while the old harness is still going. `stopping` is what
        // refuses input in the meantime.
        held.stopping = true;
        held.input.end();
        held.stream.close();
      }),

    listSessions: Effect.sync(() => [...live.values()].map((held) => held.binding)),

    // Every shipped provider's config schema is empty, so the Claude adapter
    // takes nothing from it and does not name the argument.
    probe: (ctx: ProviderRunnerContext): Effect.Effect<ProbeResult> => {
      const binary = ctx.binary;
      if (binary === undefined) {
        return Effect.succeed(failed(null, `no ${CLAUDE_BINARY} on this machine`));
      }
      const gather = Effect.gen(function* () {
        const harnessVersion = yield* versionOf(ctx, binary);
        return yield* Effect.match(ask(ctx, binary), {
          onFailure: (message) => failed(harnessVersion, message),
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
          failed(null, `the harness did not answer within ${Duration.format(PROBE_DEADLINE)}`),
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
    install: (env: Readonly<Record<string, string | undefined>>): Effect.Effect<InstallOutcome> =>
      Effect.map(
        Effect.timeoutOption(
          seam.run(
            [
              "bash",
              "-c",
              `curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_CODE_VERSION}`,
            ],
            env,
          ),
          INSTALL_DEADLINE,
        ),
        Option.match({
          onNone: () => ({
            ok: false,
            message: `the installer did not finish within ${Duration.format(INSTALL_DEADLINE)}`,
          }),
          onSome: (ran) =>
            ran.code === 0
              ? { ok: true }
              : { ok: false, message: lastLines(ran.stderr === "" ? ran.stdout : ran.stderr) },
        }),
      ),
  };
};

const LAST_LINES = 5;

const lastLines = (output: string): string => {
  const said = output.trimEnd().split("\n").slice(-LAST_LINES).join("\n");
  return said === ""
    ? "the installer failed without saying why"
    : said.slice(-MAX_INSTALL_MESSAGE_LENGTH);
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
