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
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import {
  type AccessMode,
  type ApprovalDecision,
  type ExitReason,
  type ModelSelection,
  type OpenRequest,
  type ProbeResult,
  type ProviderEvent,
  type SendResult,
  type SessionBinding,
  type SessionSpec,
  type TurnInput,
} from "@hydra/protocol";
import type { LoginCommand } from "../login";
import type { ProviderAdapter, ProviderRunnerContext } from "../index";
import { probeFailed } from "../probe";
import { userMessage } from "../events";
import { runProcess, spawnAppServer, type Run } from "../process";
import { text } from "../text";
import { now } from "../../report";
import { ASKED, type Asked } from "./approvals";
import { normalize, normalizing, pathsOf, type Normalizing } from "./normalize";
import { codexInstall, handshake, probing, saidBy, type AppServer } from "./probe";
import {
  rpcOver,
  type AppServerSpawn,
  type NotificationFrame,
  type RpcError,
  type ServerRequestFrame,
} from "./rpc";
import type {
  ApprovalsReviewer,
  AskForApproval,
  DynamicToolCallResponse,
  ItemCompletedNotification,
  ItemStartedNotification,
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

/** What an app-server writes on its way out, kept for the report when it dies. */
const MAX_COMPLAINT_LINES = 5;

export interface CodexSeam {
  readonly appServer: AppServerSpawn;
  readonly run: Run;
}

/** One app-server, what it said that was not a frame, and who is on it. */
interface Host extends AppServer {
  /** The instance this host serves; a probe's own process serves none. */
  readonly instanceId: string | undefined;
  /** Reference count, by name: the host goes when its last session does. */
  readonly sessions: Set<string>;
}

/**
 * A request the session is parked on, as a surface reads it and as it is
 * answered. The frame id is Codex's own and is echoed back verbatim, because it
 * types one as a string or a number and an answer under a reshaped id answers
 * nothing.
 */
interface Park {
  readonly id: string | number;
  readonly request: OpenRequest;
  readonly asked: Asked;
  readonly params: unknown;
}

/** One session this adapter hosts, and what it believes about its thread. */
interface Held {
  readonly binding: SessionBinding;
  readonly host: Host;
  readonly state: Normalizing;
  /** The turn believed to be running, which is what makes an input a steer. */
  turnId: string | undefined;
  /**
   * The request the session is parked on, and the ones that arrived while it
   * was open. A session has exactly one open request, so a second announced
   * before the first is answered would take its place and the first would
   * disappear from every surface with nobody able to answer it. Codex waits for
   * both, so the second waits here and is opened when the first is resolved.
   */
  open: Park | undefined;
  readonly waiting: Array<Park>;
  /**
   * What each running file change item is about. A file change approval names
   * no paths at this release, so the card reads them off the item instead.
   */
  readonly fileChanges: Map<string, ReadonlyArray<string>>;
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

/**
 * How long a control request is given. It is a write to the app-server and a
 * wait for its answer, and the runner handles session frames in the order they
 * arrived rather than concurrently, so one app-server that stops answering
 * would otherwise hold up every session on the machine - pings included.
 */
export const CONTROL_DEADLINE: Duration.Duration = Duration.seconds(5);

/** The code spec 06 section 10.2 names for a server too busy to take a turn. */
const OVERLOADED = -32001;

/** JSON-RPC's own: this build has no answer for that method. */
const METHOD_NOT_FOUND = -32601;

/** JSON-RPC's own, and the code Codex itself refuses a request it cannot read with. */
const INVALID_REQUEST = -32600;

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

/** Which thread a frame is about, where it names one at all. */
const threadIn = (params: unknown): string | undefined => {
  const threadId = (params as { readonly threadId?: unknown } | null | undefined)?.threadId;
  return typeof threadId === "string" ? threadId : undefined;
};

/** Turn input is text only: attachments are the open item in spec 16 section B. */
const textInput = (text: string): UserInput => ({ type: "text", text, text_elements: [] });

/** What the device login prints for the user to type: four characters, a dash, five. */
const USER_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/;

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
    // By identity: a stop waits on the harness, and a thread the server closed
    // or an app-server that died in that window has already ended this session.
    // A second exit would be a second row for one end.
    if (sessions.get(held.binding.sessionId) !== held) return;
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
        // Nothing a vendor writes may take the reader down, and a request that
        // threw on its way through is still a request that must be answered:
        // dropping it would hang the turn and the connection both.
        onServerRequest: (frame) => {
          try {
            onServerRequest(host, frame);
          } catch {
            refuse(host, frame, {
              code: INVALID_REQUEST,
              message: `Hydra could not read the ${frame.method} it was asked`,
            });
            warn(host, `the app-server sent a ${frame.method} this build could not read`);
          }
        },
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

  const probe = probing(openHost);

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

  const onNotification = (host: Host, frame: NotificationFrame): void => {
    const threadId = threadIn(frame.params);
    const held = threadId === undefined ? undefined : sessionOn(host, threadId);
    if (held === undefined) return;
    // The thread is unloaded and its rollout is on disk, which is what makes
    // this the one exit a later session can carry on from (spec 06 section 4.1).
    if (frame.method === "thread/closed") {
      exit(held, "idle_unload");
      return;
    }
    for (const event of normalize(held.state, frame)) emit(event);
    // A file change approval names no paths at this release, so what a card
    // shows are the item's own, held from the moment the patch is announced
    // until it is applied: the window an approval for it arrives in.
    if (frame.method === "item/started" || frame.method === "item/completed") {
      const { item } = frame.params as ItemStartedNotification | ItemCompletedNotification;
      if (item.type !== "fileChange") return;
      if (frame.method === "item/completed") held.fileChanges.delete(item.id);
      else {
        held.fileChanges.set(item.id, pathsOf(item));
      }
      return;
    }
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
      if (turn.status !== "inProgress" && turn.id === held.turnId) {
        held.turnId = undefined;
        // The controller closed the open request when the turn ended, so no
        // resolution is reported for it - but Codex is still waiting on every
        // park it asked, and a request left unanswered is a connection nobody
        // can reason about.
        cancelWaiting(held);
        const open = held.open;
        held.open = undefined;
        if (open !== undefined) cancelled(held, open);
        held.fileChanges.clear();
      }
    }
  };

  /** Tells Codex a park is over, in its own terms. Every request is answered. */
  const cancelled = (held: Held, park: Park): void => {
    held.host.rpc.answer(park.id, park.asked.replies("cancel", park.params));
  };

  /**
   * Ends every park nobody has been shown. No event: no surface was ever told
   * these existed, so there is nothing to report over.
   */
  const cancelWaiting = (held: Held): void => {
    for (const park of held.waiting.splice(0)) cancelled(held, park);
  };

  /** Puts the session on a park: exactly one is open at a time. */
  const announce = (held: Held, park: Park): void => {
    held.open = park;
    emit({
      _tag: "request.opened",
      eventId: crypto.randomUUID(),
      sessionId: held.binding.sessionId,
      at: now(),
      request: park.request,
    });
  };

  /**
   * Ends the open park: Codex is told the answer in its own terms, the stream
   * says the park is over, and the next request Codex is waiting on takes the
   * slot it left.
   */
  const resolving = (held: Held, park: Park, decision: ApprovalDecision): void => {
    held.open = undefined;
    held.host.rpc.answer(park.id, park.asked.replies(decision, park.params));
    emit({
      _tag: "request.resolved",
      eventId: crypto.randomUUID(),
      sessionId: held.binding.sessionId,
      at: now(),
      requestId: park.request.requestId,
      decision,
    });
    const next = held.waiting.shift();
    if (next !== undefined) announce(held, next);
  };

  /**
   * Answered, not dropped: a request left hanging is a turn that never ends,
   * with nothing said anywhere.
   */
  const refuse = (host: Host, frame: ServerRequestFrame, error: RpcError): void => {
    host.rpc.answer(frame.id, { error });
  };

  const onServerRequest = (host: Host, frame: ServerRequestFrame): void => {
    if (frame.method === "item/tool/call") {
      // Hydra hosts no tools for Codex, so there is nothing a user could decide
      // and nothing to wait for: the call is refused where it arrives.
      host.rpc.answer(frame.id, {
        result: {
          contentItems: [{ type: "inputText", text: "Hydra does not host dynamic tools" }],
          success: false,
        } satisfies DynamicToolCallResponse,
      });
      return;
    }
    const asked = ASKED[frame.method];
    if (asked === undefined) {
      refuse(host, frame, {
        code: METHOD_NOT_FOUND,
        message: `Hydra does not answer ${frame.method}`,
      });
      warn(host, `the app-server asked for ${frame.method}, which this runner build cannot answer`);
      return;
    }
    const threadId = threadIn(frame.params);
    const held = threadId === undefined ? undefined : sessionOn(host, threadId);
    // A thread nobody here holds has no one to ask and no one to tell: a
    // warning for it would go to every other session on this app-server.
    if (threadId === undefined || held === undefined) {
      refuse(host, frame, {
        code: INVALID_REQUEST,
        message: `no session on this runner is on thread ${String(threadId)}`,
      });
      return;
    }
    const requestId = crypto.randomUUID();
    const request = asked.opens(frame.params, {
      requestId,
      threadId,
      paths: (itemId) => held.fileChanges.get(itemId) ?? [],
    });
    const park: Park = { id: frame.id, request, asked, params: frame.params };
    // Codex asks for a second approval without waiting for the first, and waits
    // for both: this one is announced when the one in the slot is answered.
    if (held.open === undefined) announce(held, park);
    else held.waiting.push(park);
  };

  /**
   * Ends the running turn, if the adapter believes there is one. A refusal
   * means the turn is already over, which is the same outcome.
   */
  const interrupting = (held: Held): Effect.Effect<void> =>
    held.turnId === undefined
      ? Effect.void
      : Effect.ignore(
          Effect.timeout(
            held.host.rpc.request("turn/interrupt", {
              threadId: held.binding.nativeSessionId,
              turnId: held.turnId,
            } satisfies TurnInterruptParams),
            CONTROL_DEADLINE,
          ),
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
      // What the turn is running under, which is what the normalizer reports on
      // `turn.started`: the notification itself carries no model. Set before
      // the write, because `turn/started` can be read before this fiber resumes.
      const before = held.state.model;
      if (input.modelSelection !== undefined) held.state.model = input.modelSelection.model;
      const answer = yield* Effect.mapError(
        retrying(held.host.rpc.request("turn/start", params)),
        (error) => {
          // No turn opened, so the selection it would have run under is not
          // what the next one reports.
          held.state.model = before;
          return error.message;
        },
      );
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
    const effort = selection.options["effort"];
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
    probe: (ctx: ProviderRunnerContext): Effect.Effect<ProbeResult> =>
      ctx.binary === undefined
        ? Effect.succeed(probeFailed(null, `no ${CODEX_BINARY} on this machine`))
        : probe(ctx, ctx.binary),

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
        sessions.set(sessionId, {
          binding,
          host,
          state,
          turnId: undefined,
          open: undefined,
          waiting: [],
          fileChanges: new Map(),
        });
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
        if (held === undefined) return Effect.void;
        // A park nobody answered is what the turn is waiting on, so every one
        // is ended first: the harness is told the nearest refusal it can
        // express. The waiting ones go before the open one, so that answering
        // it announces none of them.
        cancelWaiting(held);
        const open = held.open;
        // The stream says the open park was cancelled, because that is what
        // ended it.
        if (open !== undefined) resolving(held, open, "cancel");
        return interrupting(held);
      }),

    respondToRequest: (
      sessionId: string,
      requestId: string,
      decision: ApprovalDecision,
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        const held = sessions.get(sessionId);
        const park = held?.open;
        // A request nobody here is parked on has nothing to answer, and the
        // request itself is the authority on which answers it takes: one it did
        // not offer is one the harness would have to substitute for.
        if (
          held === undefined ||
          park === undefined ||
          park.request.requestId !== requestId ||
          !park.request.decisions.includes(decision)
        ) {
          return Effect.void;
        }
        // An answer that ends the turn ends every park with it, so nothing
        // waiting is announced to a user who could only watch it die.
        const ending = park.asked.endsTurn.includes(decision);
        if (ending) cancelWaiting(held);
        resolving(held, park, decision);
        // Only where the answer shape cannot carry the refusal itself: every
        // other row says "stopped" to Codex in its own terms.
        return ending ? interrupting(held) : Effect.void;
      }),

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

    /**
     * The device flow rather than the browser one: the machine the harness runs
     * on usually has no browser, and this login prints a code the user types
     * into one anywhere. The homes are the instance's own, as a session's are,
     * so the credential lands where the app-server will look for it.
     */
    login: (ctx: ProviderRunnerContext, binary: string): LoginCommand => ({
      command: [binary, "login", "--device-auth"],
      env: envFor(ctx),
      userCode: USER_CODE,
    }),

    install: codexInstall(seam.run),
  };
};

export const codex: ProviderAdapter = codexAdapter({ appServer: spawnAppServer, run: runProcess });
