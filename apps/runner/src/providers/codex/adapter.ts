/**
 * The Codex adapter. Everything it knows about the harness it learns over one
 * app-server connection, and everything that connection touches lives under the
 * instance's own home: a runner that read the developer's own Codex directory
 * would mix Hydra's sessions with the user's login, skills and memory.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { CODEX_VERSION, VERSION } from "@hydra/home/version";
import {
  MAX_FACT_ITEMS,
  MAX_FACT_LENGTH,
  type AccessMode,
  type ExitReason,
  type ModelDescriptor,
  type ModelOption,
  type ModelSelection,
  type ProbeResult,
  type ProviderEvent,
  type SendResult,
  type SessionBinding,
  type SessionSpec,
  type TurnInput,
} from "@hydra/protocol";
import { INSTALL_DEADLINE, lastLines } from "../claude-code";
import type { InstallOutcome, ProviderAdapter, ProviderRunnerContext } from "../index";
import { userMessage } from "../events";
import { runProcess, spawnAppServer, type Run } from "../process";
import { fact, text } from "../text";
import { now } from "../../report";
import { normalize, normalizing, type Normalizing } from "./normalize";
import {
  rpcOver,
  type AppServerSpawn,
  type NotificationFrame,
  type Rpc,
  type RpcError,
  type ServerRequestFrame,
} from "./rpc";
import type {
  ApprovalsReviewer,
  AskForApproval,
  GetAccountResponse,
  InitializeParams,
  InitializeResponse,
  Model,
  ModelListResponse,
  SandboxMode,
  ThreadForkParams,
  ThreadResumeParams,
  ThreadStartParams,
  ThreadStartResponse,
  TurnCompletedNotification,
  TurnInterruptParams,
  TurnStartedNotification,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
  UserInput,
} from "./types";

export const CODEX = "codex";

const CODEX_BINARY = "codex";

/** Long enough for a cold app-server, short enough that a Fleet page does not look hung. */
export const PROBE_DEADLINE: Duration.Duration = Duration.seconds(15);

/** What an app-server writes on its way out, kept for the report when it dies. */
const MAX_COMPLAINT_LINES = 5;

export interface CodexSeam {
  readonly appServer: AppServerSpawn;
  readonly run: Run;
}

/** One app-server, what it said that was not a frame, and who is on it. */
interface Host {
  readonly rpc: Rpc;
  readonly kill: () => void;
  readonly complaint: () => string;
  /** The instance this host serves; a probe's own process serves none. */
  readonly instanceId: string | undefined;
  /** Reference count, by name: the host goes when its last session does. */
  readonly sessions: Set<string>;
}

/** One session this adapter hosts, and what it believes about its thread. */
interface Held {
  readonly binding: SessionBinding;
  readonly host: Host;
  readonly state: Normalizing;
  /** The turn believed to be running, which is what makes an input a steer. */
  turnId: string | undefined;
}

/**
 * What each access mode is on a Codex thread (spec 06 section 8.1).
 * `accessMode` always names a mode Codex supports natively, so there is no
 * fallback here and nothing to substitute silently.
 */
const ACCESS_MODES: Readonly<
  Record<
    AccessMode,
    {
      readonly approvalPolicy: AskForApproval;
      readonly sandbox: SandboxMode;
      readonly approvalsReviewer: ApprovalsReviewer;
    }
  >
> = {
  "approval-required": {
    approvalPolicy: "untrusted",
    sandbox: "read-only",
    approvalsReviewer: "user",
  },
  "auto-accept-edits": {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    approvalsReviewer: "user",
  },
  auto: {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    approvalsReviewer: "auto_review",
  },
  "full-access": {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    approvalsReviewer: "user",
  },
};

/** The code spec 06 section 10.2 names for a server too busy to take a turn. */
const OVERLOADED = -32001;

/** JSON-RPC's own: this build has no answer for that method. */
const METHOD_NOT_FOUND = -32601;

const RETRIES = 3;

const BACKOFF: Duration.Duration = Duration.millis(500);

/** Enough that an instance's sessions do not all come back in the same millisecond. */
const JITTER_MS = 250;

const backoff = Schedule.exponential(BACKOFF).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.map(Random.nextIntBetween(0, JITTER_MS), (jitter) =>
      Duration.sum(duration, Duration.millis(jitter)),
    ),
  ),
);

/**
 * 500, 1000 and 2000 ms, jittered. Only an overload is retried: a request the
 * server refused on its merits would be refused three more times, four seconds
 * later.
 */
const retrying = <A>(request: Effect.Effect<A, RpcError>): Effect.Effect<A, RpcError> =>
  Effect.retry(request, {
    schedule: backoff,
    times: RETRIES,
    while: (error: RpcError) => error.code === OVERLOADED,
  });

/** Turn input is text only: attachments are the open item in spec 16 section B. */
const textInput = (text: string): UserInput => ({ type: "text", text, text_elements: [] });

const failed = (harnessVersion: string | null, message: string): ProbeResult => ({
  harnessVersion,
  auth: { status: "error", message: fact(message) },
  models: [],
});

/**
 * `initialize` carries no version field, so the version is the token after the
 * first `/` of the user agent, which reads `<client>/<version> (os; arch) ...`.
 * A user agent that does not read as one reports nothing rather than a guess,
 * which `versionVerdict` already takes as "unknown".
 */
const USER_AGENT = /^[^/\s]+\/(\S+)/;

const versionOf = (userAgent: string): string | null =>
  USER_AGENT.exec(userAgent)?.[1]?.slice(0, MAX_FACT_LENGTH) ?? null;

const authOf = ({ account }: GetAccountResponse): ProbeResult["auth"] => {
  if (account === null) return { status: "unauthenticated" };
  if (account.type !== "chatgpt") return { status: "ok", backend: account.type };
  return {
    status: "ok",
    ...(account.email === null ? {} : { identity: fact(account.email) }),
    planLabel: account.planType,
    backend: account.type,
  };
};

const selecting = (
  id: string,
  label: string,
  choices: ReadonlyArray<{ readonly value: string; readonly label: string }>,
  preferred: string | null,
): ModelOption => ({
  id,
  label,
  kind: "select",
  choices,
  default: preferred ?? choices[0]!.value,
});

/**
 * Only what the model itself lists: an empty select is a control the composer
 * shows and nothing can be chosen in.
 */
const optionsFor = (model: Model): ReadonlyArray<ModelOption> => {
  const options: Array<ModelOption> = [];
  const efforts = model.supportedReasoningEfforts ?? [];
  if (efforts.length > 0) {
    options.push(
      selecting(
        "reasoningEffort",
        "Reasoning effort",
        efforts.map(({ reasoningEffort }) => ({
          value: fact(reasoningEffort),
          label: fact(`${reasoningEffort.slice(0, 1).toUpperCase()}${reasoningEffort.slice(1)}`),
        })),
        model.defaultReasoningEffort ?? null,
      ),
    );
  }
  const tiers = model.serviceTiers ?? [];
  if (tiers.length > 0) {
    options.push(
      selecting(
        "serviceTier",
        "Service tier",
        // An unnamed tier is still a tier, and the protocol will not carry an
        // empty label.
        tiers.map((tier) => ({
          value: fact(tier.id),
          label: fact(tier.name === "" || tier.name === undefined ? tier.id : tier.name),
        })),
        model.defaultServiceTier ?? null,
      ),
    );
  }
  return options;
};

const catalogOf = (models: ReadonlyArray<Model>): ReadonlyArray<ModelDescriptor> =>
  models
    // The protocol will not carry an empty slug or name.
    .filter((model) => model.id !== "" && model.displayName !== "")
    .slice(0, MAX_FACT_ITEMS)
    .map((model) => ({
      slug: fact(model.id),
      name: fact(model.displayName),
      ...(model.isDefault === true ? { isDefault: true } : {}),
      options: optionsFor(model),
    }));

/**
 * Attestation is declined here rather than left to a request nobody answers,
 * and the experimental surface is off because this build talks the methods the
 * pinned release declares.
 */
const INITIALIZE: InitializeParams = {
  clientInfo: { name: "hydra", title: "Hydra", version: VERSION },
  capabilities: { experimentalApi: false, requestAttestation: false },
};

export const codexAdapter = (seam: CodexSeam): ProviderAdapter => {
  // Creating an unbounded PubSub allocates and nothing more, so it is safe to
  // run here and keeps `adapterFor` the synchronous lookup every other caller
  // already treats it as.
  const published = Effect.runSync(PubSub.unbounded<ProviderEvent>());
  const sessions = new Map<string, Held>();
  /** One app-server per instance: its sessions share the auth refresh and the model catalog. */
  const hosts = new Map<string, Host>();

  const emit = (event: ProviderEvent): void => {
    PubSub.publishUnsafe(published, event);
  };

  /** A thread belongs to one app-server, so only that host's sessions are asked. */
  const sessionOn = (host: Host, threadId: string): Held | undefined => {
    for (const sessionId of host.sessions) {
      const held = sessions.get(sessionId);
      if (held?.binding.nativeSessionId === threadId) return held;
    }
    return undefined;
  };

  /**
   * A complaint about the connection belongs to no one thread, so every session
   * on that app-server hears it: the alternative is a session going quiet with
   * the reason kept in a log nobody is reading.
   */
  const warn = (host: Host, message: string): void => {
    for (const sessionId of host.sessions) {
      // A session whose thread is still opening has not been reported as
      // started, and a warning naming it would arrive before the session does.
      if (!sessions.has(sessionId)) continue;
      emit({
        _tag: "runtime.warning",
        eventId: crypto.randomUUID(),
        sessionId,
        at: now(),
        message: text(message),
      });
    }
  };

  /**
   * Gives up a session's claim on its app-server. The host is the instance's,
   * not the session's, so it lives exactly as long as its last session.
   */
  const release = (host: Host, sessionId: string): void => {
    host.sessions.delete(sessionId);
    if (host.sessions.size > 0) return;
    if (host.instanceId !== undefined && hosts.get(host.instanceId) === host) {
      hosts.delete(host.instanceId);
    }
    host.kill();
  };

  const exit = (held: Held, reason: ExitReason): void => {
    sessions.delete(held.binding.sessionId);
    emit({
      _tag: "session.exited",
      eventId: crypto.randomUUID(),
      sessionId: held.binding.sessionId,
      at: now(),
      reason,
    });
    release(held.host, held.binding.sessionId);
  };

  /** An app-server that stopped on its own takes every session it held with it. */
  const gone = (host: Host): void => {
    for (const sessionId of [...host.sessions]) {
      const held = sessions.get(sessionId);
      if (held !== undefined) exit(held, "process_exit");
    }
  };

  const onNotification = (host: Host, frame: NotificationFrame): void => {
    const threadId = (frame.params as { readonly threadId?: unknown } | null | undefined)?.threadId;
    const held = typeof threadId === "string" ? sessionOn(host, threadId) : undefined;
    if (held === undefined) return;
    // The thread is unloaded and its rollout is on disk, which is what makes
    // this the one exit a later session can carry on from (spec 06 section 4.1).
    if (frame.method === "thread/closed") {
      exit(held, "idle_unload");
      return;
    }
    for (const event of normalize(held.state, frame)) emit(event);
    // What the adapter believes about the turn, which is what decides whether
    // the next input steers. The turn a `turn/start` answered with is already
    // held; this is the server's own account of the same thing.
    if (frame.method === "turn/started") {
      // The turn a `turn/start` answered with is already held, and it is the
      // one this session is steering; a turn opened elsewhere is not.
      held.turnId ??= (frame.params as TurnStartedNotification).turn.id;
    } else if (frame.method === "turn/completed") {
      const turn = (frame.params as TurnCompletedNotification).turn;
      // Only the turn in flight ends the flight: a completion for another turn
      // would otherwise make the next input open a turn beside a running one.
      if (turn.status !== "inProgress" && turn.id === held.turnId) held.turnId = undefined;
    }
  };

  const onServerRequest = (host: Host, frame: ServerRequestFrame): void => {
    // Answered, not dropped: a request left hanging is a turn that never ends,
    // with nothing said anywhere. The mapped requests arrive with approvals.
    host.rpc.answer(frame.id, {
      error: { code: METHOD_NOT_FOUND, message: `Hydra does not answer ${frame.method}` },
    });
    warn(host, `the app-server asked for ${frame.method}, which this runner build cannot answer`);
  };

  /**
   * `CODEX_HOME` alone does not isolate a session: Codex reads skills out of
   * the user's `~/.agents/skills`, so `HOME` is relocated to an empty directory
   * of the instance's own. Doing it here rather than in the session context is
   * what keeps Claude's Keychain lookup working, which a relocated `HOME`
   * breaks.
   */
  const envFor = (ctx: ProviderRunnerContext): Record<string, string | undefined> => {
    const codexHome = join(ctx.home, "codex");
    const neutral = join(ctx.home, "home");
    for (const directory of [codexHome, neutral]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    return { ...ctx.env, CODEX_HOME: codexHome, HOME: neutral };
  };

  const startHost = (
    ctx: ProviderRunnerContext,
    binary: string,
    instanceId: string | undefined,
  ): Host => {
    const complaints: Array<string> = [];
    const child = seam.appServer(
      // `--strict-config` turns a knob renamed in an upgrade from silent drift
      // into a start failure, and the updater is off because a harness that
      // updated itself would run a version nobody chose.
      [binary, "app-server", "--strict-config", "-c", "check_for_update_on_startup=false"],
      envFor(ctx),
    );
    const remember = (line: string): void => {
      complaints.push(line);
      if (complaints.length > MAX_COMPLAINT_LINES) complaints.shift();
    };
    void (async () => {
      try {
        for await (const line of child.stderr) if (line.trim() !== "") remember(line);
      } catch {
        // A child killed mid-read has nothing more to complain about, and what
        // it already said is still worth reporting.
      }
    })();
    const host: Host = {
      rpc: rpcOver(child, {
        onServerRequest: (frame) => onServerRequest(host, frame),
        // Nothing a vendor writes may take the reader down: a throw here would
        // abandon every request in flight on this connection.
        onNotification: (frame) => {
          try {
            onNotification(host, frame);
          } catch {
            warn(host, `the app-server sent a ${frame.method} this build could not read`);
          }
        },
        onWarning: (message) => {
          remember(message);
          warn(host, message);
        },
      }),
      kill: child.kill,
      complaint: () => complaints.join("\n"),
      instanceId,
      sessions: new Set(),
    };
    void child.exited.then(
      () => gone(host),
      () => gone(host),
    );
    Effect.runFork(host.rpc.pump);
    return host;
  };

  /** A home this runner may not write is an ordinary state, not a defect. */
  const openHost = (
    ctx: ProviderRunnerContext,
    binary: string,
    instanceId?: string,
  ): Effect.Effect<Host, string> =>
    Effect.try({
      try: () => startHost(ctx, binary, instanceId),
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    });

  /** Nothing else may be asked of an app-server until this has been answered. */
  const handshake = (host: Host): Effect.Effect<InitializeResponse, RpcError> =>
    Effect.map(host.rpc.request("initialize", INITIALIZE), (answer) => {
      host.rpc.notify("initialized");
      return answer as InitializeResponse;
    });

  /** What the app-server said, in preference to what the codec made of it. */
  const saidBy = (host: Host, error: RpcError): string => {
    const said = host.complaint();
    return said === "" ? error.message : said;
  };

  const hostFor = (
    instanceId: string,
    ctx: ProviderRunnerContext,
    binary: string,
  ): Effect.Effect<Host, string> =>
    Effect.suspend(() => {
      const running = hosts.get(instanceId);
      if (running !== undefined) return Effect.succeed(running);
      return Effect.flatMap(openHost(ctx, binary, instanceId), (host) =>
        Effect.matchEffect(handshake(host), {
          // Registered only once it has answered: a host kept under an instance
          // id without a handshake is one every later session would talk to and
          // none of them could, and its child would outlive the runner.
          onFailure: (error) => {
            const said = saidBy(host, error);
            host.kill();
            return Effect.fail(said);
          },
          onSuccess: () => {
            hosts.set(instanceId, host);
            return Effect.succeed(host);
          },
        }),
      );
    });

  const unbuilt = (what: string): Effect.Effect<never> =>
    Effect.die(new Error(`${what} is not implemented in this runner build`));

  /**
   * Ends the running turn, if the adapter believes there is one. A refusal
   * means the turn is already over, which is the same outcome.
   */
  const interrupting = (held: Held): Effect.Effect<void> =>
    held.turnId === undefined
      ? Effect.void
      : Effect.ignore(
          held.host.rpc.request("turn/interrupt", {
            threadId: held.binding.nativeSessionId,
            turnId: held.turnId,
          } satisfies TurnInterruptParams),
        );

  const hosting = (sessionId: string): Effect.Effect<Held, string> =>
    Effect.suspend(() => {
      const held = sessions.get(sessionId);
      return held === undefined
        ? Effect.fail(`session ${sessionId} is not running here`)
        : Effect.succeed(held);
    });

  /**
   * Opens a turn on the session's current selection. Codex takes the model,
   * the reasoning effort and the service tier per turn, and `TurnInput` carries
   * the session's selection on every frame, so it is sent every time rather
   * than tracked here: a selection changed and changed back would otherwise be
   * remembered as no change at all.
   */
  const opening = (held: Held, input: TurnInput): Effect.Effect<SendResult, string> =>
    Effect.gen(function* () {
      const params: TurnStartParams = {
        threadId: held.binding.nativeSessionId,
        input: [textInput(input.text)],
        ...modelParams(input.modelSelection),
      };
      const answer = yield* Effect.mapError(
        retrying(held.host.rpc.request("turn/start", params)),
        (error) => error.message,
      );
      // What the turn is running under, which is what the normalizer reports on
      // `turn.started`: the notification itself carries no model.
      if (input.modelSelection !== undefined) held.state.model = input.modelSelection.model;
      return { turnId: (answer as TurnStartResponse).turn.id, delivery: "opened" };
    });

  /**
   * Steers the turn the adapter believes is running, and answers with nothing
   * where it could not: the precondition failed, the turn is not steerable, or
   * it ended between the belief and the call. The caller opens a turn instead,
   * because input is never bounced.
   */
  const steering = (
    held: Held,
    text: string,
    expectedTurnId: string,
  ): Effect.Effect<SendResult | undefined> =>
    Effect.match(
      retrying(
        held.host.rpc.request("turn/steer", {
          threadId: held.binding.nativeSessionId,
          input: [textInput(text)],
          expectedTurnId,
        } satisfies TurnSteerParams),
      ),
      {
        onFailure: () => undefined,
        onSuccess: (answer): SendResult => ({
          turnId: (answer as TurnSteerResponse).turnId,
          delivery: "steered",
        }),
      },
    );

  /**
   * A selection as Codex takes it. The option ids are the ones the probe put on
   * the model descriptor, so a composer that offers one sends it back by name.
   */
  const modelParams = (
    selection: ModelSelection | undefined,
  ): Pick<TurnStartParams, "model" | "effort" | "serviceTier"> => {
    if (selection === undefined) return {};
    const effort = selection.options["reasoningEffort"];
    const tier = selection.options["serviceTier"];
    return {
      model: selection.model,
      ...(typeof effort === "string" ? { effort } : {}),
      ...(typeof tier === "string" ? { serviceTier: tier } : {}),
    };
  };

  /** What a thread is opened, resumed or forked with: the session's own row. */
  const threadParams = (
    spec: SessionSpec,
    ctx: ProviderRunnerContext,
  ): Pick<
    ThreadStartParams,
    "cwd" | "model" | "serviceTier" | "approvalPolicy" | "sandbox" | "approvalsReviewer"
  > => {
    const tier = spec.modelSelection.options["serviceTier"];
    return {
      cwd: ctx.cwd,
      model: spec.modelSelection.model,
      ...(typeof tier === "string" ? { serviceTier: tier } : {}),
      ...ACCESS_MODES[spec.accessMode],
    };
  };

  return {
    providerId: CODEX,
    binaryName: CODEX_BINARY,

    events: Stream.fromPubSub(published),

    // Every shipped provider's config schema is empty, so the Codex adapter
    // takes nothing from it and does not name the argument.
    probe: (ctx: ProviderRunnerContext): Effect.Effect<ProbeResult> => {
      const binary = ctx.binary;
      if (binary === undefined) {
        return Effect.succeed(failed(null, `no ${CODEX_BINARY} on this machine`));
      }
      // A probe runs on a process of its own and kills it: sharing the
      // connection a session runs on would keep an app-server alive for a Fleet
      // page nobody is looking at any more.
      const gather = Effect.acquireUseRelease(
        openHost(ctx, binary),
        (host) =>
          Effect.matchEffect(handshake(host), {
            onFailure: (error) => Effect.succeed(failed(null, saidBy(host, error))),
            onSuccess: (initialized) =>
              Effect.match(
                Effect.all([
                  host.rpc.request("account/read", {}),
                  host.rpc.request("model/list", {}),
                ]),
                {
                  onFailure: (error) =>
                    failed(versionOf(initialized.userAgent), saidBy(host, error)),
                  onSuccess: ([account, models]) => ({
                    harnessVersion: versionOf(initialized.userAgent),
                    auth: authOf(account as GetAccountResponse),
                    models: catalogOf((models as ModelListResponse).data),
                  }),
                },
              ),
          }),
        (host) => Effect.sync(() => host.kill()),
      ).pipe(Effect.catch((message) => Effect.succeed(failed(null, message))));
      return Effect.map(
        Effect.timeoutOption(gather, PROBE_DEADLINE),
        Option.getOrElse(() =>
          failed(null, `the app-server did not answer within ${Duration.format(PROBE_DEADLINE)}`),
        ),
      );
    },

    startSession: (sessionId, spec, ctx) =>
      Effect.gen(function* () {
        const binary = ctx.binary;
        if (binary === undefined) return yield* Effect.fail(`no ${CODEX_BINARY} on this machine`);
        const host = yield* hostFor(spec.instanceId, ctx, binary);
        // Claimed before the thread is asked for, so a thread that never opens
        // gives the host back rather than leaving a process nobody talks to.
        host.sessions.add(sessionId);
        const carried = spec.continue;
        const opened = yield* Effect.matchEffect(
          carried === undefined
            ? host.rpc.request("thread/start", {
                ...threadParams(spec, ctx),
                ephemeral: false,
              } satisfies ThreadStartParams)
            : host.rpc.request(carried.mode === "resume" ? "thread/resume" : "thread/fork", {
                threadId: carried.nativeSessionId,
                ...threadParams(spec, ctx),
              } satisfies ThreadResumeParams & ThreadForkParams),
          {
            onFailure: (error: RpcError) => {
              release(host, sessionId);
              return Effect.fail(error.message);
            },
            // A fork is a thread of its own, so the id answered with is the
            // session's; the one it was forked from is left alone.
            onSuccess: (answer) => Effect.succeed((answer as ThreadStartResponse).thread.id),
          },
        );
        const binding: SessionBinding = {
          sessionId,
          nativeSessionId: opened,
          instanceId: spec.instanceId,
        };
        const state = normalizing(sessionId, opened);
        state.model = spec.modelSelection.model;
        sessions.set(sessionId, { binding, host, state, turnId: undefined });
        // The native id rides the event, because the controller has no other
        // way to learn it: a session started after hello is never named again.
        emit({
          _tag: "session.started",
          eventId: crypto.randomUUID(),
          sessionId,
          at: now(),
          providerRefs: { nativeSessionId: opened },
        });
        return binding;
      }),

    sendInput: (sessionId: string, input: TurnInput): Effect.Effect<SendResult, string> =>
      Effect.gen(function* () {
        const held = yield* hosting(sessionId);
        const running = held.turnId;
        const steered =
          running === undefined ? undefined : yield* steering(held, input.text, running);
        const sent = steered ?? (yield* opening(held, input));
        // In flight from the answer, not from the notification that follows it:
        // an input arriving in between would open a second turn.
        held.turnId = sent.turnId;
        for (const event of userMessage({
          sessionId,
          turnId: sent.turnId,
          text: input.text,
          steered: sent.delivery === "steered",
          providerRefs: { threadId: held.binding.nativeSessionId },
        })) {
          emit(event);
        }
        return sent;
      }),

    interrupt: (sessionId: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        const held = sessions.get(sessionId);
        // The turn completing as `interrupted` is the whole report.
        return held === undefined ? Effect.void : interrupting(held);
      }),

    respondToRequest: () => unbuilt("answering a Codex request"),

    stopSession: (sessionId: string, reason: ExitReason): Effect.Effect<void> =>
      Effect.suspend(() => {
        const held = sessions.get(sessionId);
        // A session whose thread the server unloaded, or whose app-server died,
        // has already exited: a second exit would be a second row for one end.
        if (held === undefined) return Effect.void;
        // The turn is ended before the session is: an app-server this instance
        // keeps for its other sessions would otherwise go on working in the
        // workspace, with every notification about it going nowhere.
        return Effect.andThen(
          interrupting(held),
          Effect.sync(() => exit(held, reason)),
        );
      }),

    listSessions: Effect.sync(() => [...sessions.values()].map((held) => held.binding)),

    /** The script URL is pinned to the tag, so it and the release it fetches move together. */
    install: (env: Readonly<Record<string, string | undefined>>): Effect.Effect<InstallOutcome> =>
      Effect.map(
        Effect.timeoutOption(
          seam.run(
            [
              "bash",
              "-c",
              `curl -fsSL https://raw.githubusercontent.com/openai/codex/rust-v${CODEX_VERSION}/scripts/install/install.sh | CODEX_RELEASE=${CODEX_VERSION} CODEX_NON_INTERACTIVE=1 sh`,
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

export const codex: ProviderAdapter = codexAdapter({ appServer: spawnAppServer, run: runProcess });
