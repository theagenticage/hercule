/**
 * The Codex adapter. It talks to Codex only through app-server connections,
 * and every file an app-server uses lives under the instance's own home
 * directory. Using the developer's own Codex directory would mix Hercule's
 * sessions with the user's login, skills and memory.
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
} from "@hercule/protocol";
import type { LoginCommand } from "../login";
import type { ProviderAdapter, ProviderRunnerContext } from "../index";
import { buildFailedProbe } from "../probe";
import { buildUserMessage } from "../events";
import { runProcess, spawnAppServer, type Run } from "../process";
import { truncateMessage } from "../text";
import { now } from "../../report";
import { ASKED, type Asked } from "./approvals";
import { normalize, readChangedPaths, buildNormalizingState, type Normalizing } from "./normalize";
import {
  makeCodexInstall,
  initializeAppServer,
  makeProbe,
  describeRpcError,
  STANDARD_TIER,
  type AppServer,
} from "./probe";
import {
  makeRpc,
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
  JsonValue,
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

/**
 * How many of the app-server's last non-frame lines are kept, so they can be
 * reported if it fails.
 */
const MAX_COMPLAINT_LINES = 5;

export interface CodexSeam {
  readonly appServer: AppServerSpawn;
  readonly run: Run;
}

/** One running app-server and the session it serves. */
interface Host extends AppServer {
  /** The one session this host serves; a probe's own app-server serves none. */
  readonly sessionId: string | undefined;
}

/**
 * A request from Codex that the session is parked on: the request surfaces
 * show, and what is needed to reply to it. `id` is Codex's own frame id and
 * is sent back unchanged. Codex uses both string and number ids, and a reply
 * under a converted id would not match the request.
 */
interface Park {
  readonly id: string | number;
  readonly request: OpenRequest;
  readonly asked: Asked;
  readonly params: unknown;
}

/** One session this adapter hosts, and what the adapter knows about its thread. */
interface Held {
  readonly binding: SessionBinding;
  readonly host: Host;
  readonly state: Normalizing;
  /** The turn the adapter believes is running. While it is set, an input steers that turn. */
  turnId: string | undefined;
  /**
   * The request the session is parked on, and the requests that arrived while
   * it was open. A session has at most one open request. If a second one were
   * opened before the first was resolved, it would replace the first, and the
   * first would vanish from every surface with no way to answer it. Codex
   * waits for both, so the second waits here and is opened once the first is
   * resolved.
   */
  open: Park | undefined;
  readonly waiting: Array<Park>;
  /**
   * The paths of each running file change item, by item id. A file change
   * request has no paths at this release, so the card takes them from the item.
   */
  readonly fileChanges: Map<string, ReadonlyArray<string>>;
}

/**
 * The Codex thread settings for each access mode (spec 06 section 8.1). Codex
 * supports every access mode natively, so there is no fallback here and
 * nothing is silently substituted.
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
 * How long a control request, such as an interrupt, may take. The runner handles
 * session frames one at a time, in order, so without this timeout one
 * app-server that stops replying would hold up every session on the machine,
 * pings included.
 */
export const CONTROL_DEADLINE: Duration.Duration = Duration.seconds(5);

/** The error code for a server too busy to start a turn (spec 06 section 10.2). */
const OVERLOADED = -32001;

/** The standard JSON-RPC code for a method this build does not handle. */
const METHOD_NOT_FOUND = -32601;

/**
 * The standard JSON-RPC code for an invalid request. Codex also uses it for
 * requests it cannot parse.
 */
const INVALID_REQUEST = -32600;

const RETRIES = 3;

const BACKOFF: Duration.Duration = Duration.millis(500);

/** The maximum random delay added to each retry, so sessions do not all retry at once. */
const JITTER_MS = 250;

const backoff = Schedule.exponential(BACKOFF).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.map(Random.nextIntBetween(0, JITTER_MS), (jitter) =>
      Duration.sum(duration, Duration.millis(jitter)),
    ),
  ),
);

/**
 * Retries a request while the server reports it is overloaded, up to three
 * times, after 500, 1000 and 2000 ms plus jitter. Other errors are not
 * retried: a request the server rejected for its content would just be
 * rejected three more times.
 */
const retryWhileOverloaded = <A>(request: Effect.Effect<A, RpcError>): Effect.Effect<A, RpcError> =>
  Effect.retry(request, {
    schedule: backoff,
    times: RETRIES,
    while: (error: RpcError) => error.code === OVERLOADED,
  });

/** Returns the `threadId` in a frame's params, or `undefined` if there is none. */
const readThreadId = (params: unknown): string | undefined => {
  const threadId = (params as { readonly threadId?: unknown } | null | undefined)?.threadId;
  return typeof threadId === "string" ? threadId : undefined;
};

/**
 * Builds the developer instructions for one thread. A Codex thread accepts only
 * one set of instructions, so the session's system prompt and the skill are
 * joined: the prompt first, then a blank line, then the skill. If either is
 * missing, the other is used alone, so the text never starts with a blank line.
 */
const buildDeveloperInstructions = (systemPrompt: string | undefined, skill: string): string =>
  [systemPrompt, skill].filter((part) => part !== undefined && part !== "").join("\n\n");

/** Builds a text-only turn input. Attachments are still an open item (spec 16 section B). */
const buildTextInput = (text: string): UserInput => ({ type: "text", text, text_elements: [] });

/** Matches the code the device login prints for the user to type: four characters, a dash, five. */
const USER_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/;

export const makeCodexAdapter = (seam: CodexSeam): ProviderAdapter => {
  // Creating an unbounded PubSub allocates and nothing more, so it is safe to
  // run here and keeps `findAdapter` the synchronous lookup every other caller
  // already treats it as.
  const published = Effect.runSync(PubSub.unbounded<ProviderEvent>());
  const sessions = new Map<string, Held>();
  /**
   * One app-server per session, not per instance. The session's own token is
   * in the environment its process was started with, and every shell command
   * that process runs inherits it. If a second session shared the host, its
   * work would run under the first session's credential, grants and actor
   * stamp, and the host would stop working for both as soon as the first
   * session's token was revoked (spec 06 section 9.3). As a result, the auth
   * refresh and the model catalog are per process too.
   */
  const hosts = new Map<string, Host>();

  const emit = (event: ProviderEvent): void => {
    PubSub.publishUnsafe(published, event);
  };

  /** Returns the session this host serves, or `undefined` until its thread is open. */
  const findHostSession = (host: Host): Held | undefined =>
    host.sessionId === undefined ? undefined : sessions.get(host.sessionId);

  /**
   * Returns the session on this host whose thread is `threadId`, or
   * `undefined`. A thread belongs to one app-server, so only this host's
   * session is checked.
   */
  const findThreadSession = (host: Host, threadId: string): Held | undefined => {
    const held = findHostSession(host);
    return held?.binding.nativeSessionId === threadId ? held : undefined;
  };

  /**
   * Emits a warning about the connection to the session on this host. A
   * connection problem belongs to no thread, but reporting it to the session
   * is better than the session going quiet with the reason only in a log.
   * Nothing is emitted when the host has no session: a probe's own host has
   * none, and a session whose thread is still opening has not been reported
   * as started yet, so a warning for it would arrive before its start.
   */
  const warn = (host: Host, message: string): void => {
    const held = findHostSession(host);
    if (held === undefined) return;
    emit({
      _tag: "runtime.warning",
      eventId: crypto.randomUUID(),
      sessionId: held.binding.sessionId,
      at: now(),
      message: truncateMessage(message),
    });
  };

  /**
   * Kills a session's app-server and forgets it. The host belongs to that
   * session alone, so killing it leaves no process running with the
   * session's token.
   */
  const releaseHost = (host: Host): void => {
    if (host.sessionId !== undefined && hosts.get(host.sessionId) === host) {
      hosts.delete(host.sessionId);
    }
    host.kill();
  };

  const exitSession = (held: Held, reason: ExitReason): void => {
    // Compared by identity: a stop waits on the harness, and in that time the
    // server may close the thread or the app-server may die, which already
    // ended this session. A second exit would record the same end twice.
    if (sessions.get(held.binding.sessionId) !== held) return;
    sessions.delete(held.binding.sessionId);
    emit({
      _tag: "session.exited",
      eventId: crypto.randomUUID(),
      sessionId: held.binding.sessionId,
      at: now(),
      reason,
    });
    releaseHost(held.host);
  };

  /** Ends the host's session when its app-server exits on its own. */
  const onHostGone = (host: Host): void => {
    const held = findHostSession(host);
    if (held !== undefined) exitSession(held, "process_exit");
  };

  /**
   * Builds the environment for a Codex process, creating the instance's
   * `codex` and `home` directories if needed. `CODEX_HOME` alone does not
   * isolate a session: Codex also reads skills from the user's
   * `~/.agents/skills`, so `HOME` is moved to an empty directory of the
   * instance's own. This is done here, not in the shared session context,
   * because a moved `HOME` breaks Claude's Keychain lookup.
   */
  const prepareEnv = (ctx: ProviderRunnerContext): Record<string, string | undefined> => {
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
    sessionId: string | undefined,
  ): Host => {
    const complaints: Array<string> = [];
    const child = seam.appServer(
      // `--strict-config` makes a setting renamed in an upgrade fail the start
      // instead of being silently ignored. The updater is off because a
      // harness that updated itself would run a version nobody chose.
      [binary, "app-server", "--strict-config", "-c", "check_for_update_on_startup=false"],
      prepareEnv(ctx),
    );
    const rememberComplaint = (line: string): void => {
      complaints.push(line);
      if (complaints.length > MAX_COMPLAINT_LINES) complaints.shift();
    };
    void (async () => {
      try {
        for await (const line of child.stderr) if (line.trim() !== "") rememberComplaint(line);
      } catch {
        // A child killed while stderr is being read writes nothing more, and
        // the lines already kept are still worth reporting.
      }
    })();
    const host: Host = {
      rpc: makeRpc(child, {
        // Nothing Codex sends may crash the reader. A request whose handling
        // threw still needs a reply: without one, the turn and the connection
        // would both hang.
        onServerRequest: (frame) => {
          try {
            onServerRequest(host, frame);
          } catch {
            refuseRequest(host, frame, {
              code: INVALID_REQUEST,
              message: `Hercule could not read this ${frame.method} request`,
            });
            warn(host, `the app-server sent a ${frame.method} that this build could not read`);
          }
        },
        // Nothing Codex sends may crash the reader: a throw here would fail
        // every request in flight on this connection.
        onNotification: (frame) => {
          try {
            onNotification(host, frame);
          } catch {
            warn(host, `the app-server sent a ${frame.method} that this build could not read`);
          }
        },
        onWarning: (message) => {
          rememberComplaint(message);
          warn(host, message);
        },
      }),
      kill: child.kill,
      complaint: () => complaints.join("\n"),
      sessionId,
    };
    void child.exited.then(
      () => onHostGone(host),
      () => onHostGone(host),
    );
    Effect.runFork(host.rpc.pump);
    return host;
  };

  /**
   * Starts an app-server, failing with the error message if it cannot be
   * started. A home directory the runner cannot write to is an expected
   * failure, not a defect.
   */
  const openHost = (
    ctx: ProviderRunnerContext,
    binary: string,
    sessionId?: string,
  ): Effect.Effect<Host, string> =>
    Effect.try({
      try: () => startHost(ctx, binary, sessionId),
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    });

  const probe = makeProbe(openHost);

  const startSessionHost = (
    sessionId: string,
    ctx: ProviderRunnerContext,
    binary: string,
  ): Effect.Effect<Host, string> =>
    Effect.suspend(() => {
      // A session resumed in place starts again under the same id. An entry
      // left here belongs to the run that ended: it must not be used, and must
      // not keep running with a revoked token.
      const stale = hosts.get(sessionId);
      if (stale !== undefined) {
        hosts.delete(sessionId);
        stale.kill();
      }
      return Effect.flatMap(openHost(ctx, binary, sessionId), (host) =>
        Effect.matchEffect(initializeAppServer(host), {
          // Registered only after the handshake succeeds. A host registered
          // without one could never be used, and its child would outlive the
          // runner.
          onFailure: (error) => {
            const said = describeRpcError(host, error);
            host.kill();
            return Effect.fail(said);
          },
          onSuccess: () => {
            hosts.set(sessionId, host);
            return Effect.succeed(host);
          },
        }),
      );
    });

  const onNotification = (host: Host, frame: NotificationFrame): void => {
    const threadId = readThreadId(frame.params);
    const held = threadId === undefined ? undefined : findThreadSession(host, threadId);
    if (held === undefined) return;
    // The thread is unloaded and its rollout is on disk, so this is the one
    // exit a later session can continue from (spec 06 section 4.1).
    if (frame.method === "thread/closed") {
      exitSession(held, "idle_unload");
      return;
    }
    for (const event of normalize(held.state, frame)) emit(event);
    // A file change request has no paths at this release, so the card shows
    // the item's paths. They are kept from when the item starts until it
    // completes, which is when a request for it can arrive.
    if (frame.method === "item/started" || frame.method === "item/completed") {
      const { item } = frame.params as ItemStartedNotification | ItemCompletedNotification;
      if (item.type !== "fileChange") return;
      if (frame.method === "item/completed") held.fileChanges.delete(item.id);
      else {
        held.fileChanges.set(item.id, readChangedPaths(item));
      }
      return;
    }
    // Track which turn is running, which decides whether the next input
    // steers it.
    if (frame.method === "turn/started") {
      // The turn id from the `turn/start` reply is already set, and it is the
      // turn this session steers. A turn started some other way does not
      // replace it.
      held.turnId ??= (frame.params as TurnStartedNotification).turn.id;
    } else if (frame.method === "turn/completed") {
      const turn = (frame.params as TurnCompletedNotification).turn;
      // Only the running turn's completion clears it. Otherwise a completion
      // for another turn would make the next input start a second turn
      // beside the running one.
      if (turn.status !== "inProgress" && turn.id === held.turnId) {
        held.turnId = undefined;
        // The controller closes the open request when the turn ends, so no
        // resolution is reported for it. But Codex is still waiting for a
        // reply to every request it sent, and a request left without a reply
        // leaves the connection in an unknown state.
        cancelWaiting(held);
        const open = held.open;
        held.open = undefined;
        if (open !== undefined) cancelPark(held, open);
        held.fileChanges.clear();
      }
    }
  };

  /** Replies to a request with a cancel, in the reply shape Codex expects for it. */
  const cancelPark = (held: Held, park: Park): void => {
    held.host.rpc.answer(park.id, park.asked.replies("cancel", park.params));
  };

  /**
   * Cancels every waiting request that was never shown to the user. No event
   * is emitted, because no surface was ever told these requests existed.
   */
  const cancelWaiting = (held: Held): void => {
    for (const park of held.waiting.splice(0)) cancelPark(held, park);
  };

  /** Makes `park` the session's open request and emits `request.opened`. */
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
   * Resolves the open request: replies to Codex with the decision, emits
   * `request.resolved`, and opens the next waiting request, if any.
   */
  const resolvePark = (held: Held, park: Park, decision: ApprovalDecision): void => {
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
   * Replies to a server request with an error. The request gets a reply
   * rather than being dropped, because a request with no reply leaves the
   * turn hanging forever, with no error anywhere.
   */
  const refuseRequest = (host: Host, frame: ServerRequestFrame, error: RpcError): void => {
    host.rpc.answer(frame.id, { error });
  };

  const onServerRequest = (host: Host, frame: ServerRequestFrame): void => {
    if (frame.method === "item/tool/call") {
      // Hercule provides no dynamic tools to Codex, so there is nothing for a
      // user to decide: the call is declined immediately.
      host.rpc.answer(frame.id, {
        result: {
          contentItems: [{ type: "inputText", text: "Hercule does not host dynamic tools" }],
          success: false,
        } satisfies DynamicToolCallResponse,
      });
      return;
    }
    const asked = ASKED[frame.method];
    if (asked === undefined) {
      refuseRequest(host, frame, {
        code: METHOD_NOT_FOUND,
        message: `Hercule does not support ${frame.method}`,
      });
      warn(host, `the app-server sent ${frame.method}, which this runner build does not support`);
      return;
    }
    const threadId = readThreadId(frame.params);
    const held = threadId === undefined ? undefined : findThreadSession(host, threadId);
    // No session here holds the thread, so there is nobody to ask. No warning
    // is emitted either: it would go to a session the request is not about.
    if (threadId === undefined || held === undefined) {
      refuseRequest(host, frame, {
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
    // Codex can send a second request before the first is resolved, and waits
    // for both. The second is opened once the first is resolved.
    if (held.open === undefined) announce(held, park);
    else held.waiting.push(park);
  };

  /**
   * Interrupts the running turn, if the adapter believes there is one. Never
   * fails: an error reply means the turn is already over, which is the same
   * outcome, and a timeout is ignored too.
   */
  const interruptTurn = (held: Held): Effect.Effect<void> =>
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

  const getHostedSession = (sessionId: string): Effect.Effect<Held, string> =>
    Effect.suspend(() => {
      const held = sessions.get(sessionId);
      return held === undefined
        ? Effect.fail(`session ${sessionId} is not running here`)
        : Effect.succeed(held);
    });

  /**
   * Starts a turn with the session's current model selection. Returns the new
   * turn id, or fails with the server's error message. Codex takes the model,
   * reasoning effort and service tier per turn, and every `TurnInput` carries
   * the session's selection, so the selection is sent on every turn rather
   * than tracked here.
   */
  const startTurn = (held: Held, input: TurnInput): Effect.Effect<SendResult, string> =>
    Effect.gen(function* () {
      // Codex takes the schema per turn, not per thread, so every turn of the
      // session sends it. If it were sent only once, the second turn of an
      // Agent's session would answer in prose.
      const schema = held.state.outputSchema;
      const params: TurnStartParams = {
        threadId: held.binding.nativeSessionId,
        input: [buildTextInput(input.text)],
        ...buildModelParams(input.modelSelection),
        // The cast is safe because nothing here reads the value back. The
        // schema crosses the wire as the JSON the controller stored, and
        // Codex's own JSON type is the mutable type ts-rs writes.
        ...(schema === undefined ? {} : { outputSchema: schema as JsonValue }),
      };
      // The normalizer reports this model on `turn.started`, because the
      // notification has no model. It is set before the request is sent,
      // because `turn/started` can arrive before this fiber resumes.
      const before = held.state.model;
      if (input.modelSelection !== undefined) held.state.model = input.modelSelection.model;
      const answer = yield* Effect.mapError(
        retryWhileOverloaded(held.host.rpc.request("turn/start", params)),
        (error) => {
          // No turn started, so restore the previous model for the next turn
          // to report.
          held.state.model = before;
          return error.message;
        },
      );
      return { turnId: (answer as TurnStartResponse).turn.id, delivery: "opened" };
    });

  /**
   * Steers the turn the adapter believes is running. Returns `undefined` if
   * the steer failed: the expected turn id did not match, the turn cannot be
   * steered, or the turn ended before the call. The caller then starts a new
   * turn instead, because input is never rejected.
   */
  const steerTurn = (
    held: Held,
    text: string,
    expectedTurnId: string,
  ): Effect.Effect<SendResult | undefined> =>
    Effect.match(
      retryWhileOverloaded(
        held.host.rpc.request("turn/steer", {
          threadId: held.binding.nativeSessionId,
          input: [buildTextInput(text)],
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
   * Returns the service tier to send to Codex, or `undefined` for none.
   * `STANDARD_TIER` is Hercule's name for Codex's default tier and is not an
   * id Codex knows, so selecting it sends no `serviceTier` field.
   */
  const readServiceTier = (selected: unknown): string | undefined =>
    typeof selected === "string" && selected !== STANDARD_TIER ? selected : undefined;

  /**
   * Converts a model selection into Codex's turn params. The option ids are
   * the ones the probe put on the model descriptor, so the composer sends
   * them back under the same names.
   */
  const buildModelParams = (
    selection: ModelSelection | undefined,
  ): Pick<TurnStartParams, "model" | "effort" | "serviceTier"> => {
    if (selection === undefined) return {};
    const effort = selection.options["effort"];
    const tier = readServiceTier(selection.options["serviceTier"]);
    return {
      model: selection.model,
      ...(typeof effort === "string" ? { effort } : {}),
      ...(tier === undefined ? {} : { serviceTier: tier }),
    };
  };

  /**
   * Builds the params shared by starting, resuming and forking a thread: the
   * session's directory, model and access mode, and its instructions. The
   * system prompt and the skill are sent as developer instructions, which all
   * three methods accept (spec 06 section 9.3). No `AGENTS.md` is written, so
   * the scratch directory a session runs in stays empty.
   *
   * Nothing in this adapter reads `disallowedTools`. Codex cannot restrict
   * tools, and the Agent record and the Session record both report the field
   * as not enforced, so no behaviour is silently substituted.
   */
  const buildThreadParams = (
    spec: SessionSpec,
    ctx: ProviderRunnerContext,
  ): Pick<
    ThreadStartParams,
    | "cwd"
    | "model"
    | "serviceTier"
    | "approvalPolicy"
    | "sandbox"
    | "approvalsReviewer"
    | "developerInstructions"
  > => {
    const tier = readServiceTier(spec.modelSelection.options["serviceTier"]);
    return {
      cwd: ctx.cwd,
      model: spec.modelSelection.model,
      developerInstructions: buildDeveloperInstructions(spec.systemPrompt, ctx.herculeTool.skill),
      ...(tier === undefined ? {} : { serviceTier: tier }),
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
        ? Effect.succeed(buildFailedProbe(null, `no ${CODEX_BINARY} on this machine`))
        : probe(ctx, ctx.binary),

    startSession: (sessionId, spec, ctx) =>
      Effect.gen(function* () {
        const binary = ctx.binary;
        if (binary === undefined) return yield* Effect.fail(`no ${CODEX_BINARY} on this machine`);
        const host = yield* startSessionHost(sessionId, ctx, binary);
        const carried = spec.continue;
        const opened = yield* Effect.matchEffect(
          carried === undefined
            ? host.rpc.request("thread/start", {
                ...buildThreadParams(spec, ctx),
                ephemeral: false,
              } satisfies ThreadStartParams)
            : host.rpc.request(carried.mode === "resume" ? "thread/resume" : "thread/fork", {
                threadId: carried.nativeSessionId,
                ...buildThreadParams(spec, ctx),
              } satisfies ThreadResumeParams & ThreadForkParams),
          {
            onFailure: (error: RpcError) => {
              // The thread did not open, so kill the host rather than leave a
              // process running that nothing uses.
              releaseHost(host);
              return Effect.fail(error.message);
            },
            // A fork is a new thread, so the session takes the id in the
            // reply; the thread it was forked from is left alone.
            onSuccess: (answer) => Effect.succeed((answer as ThreadStartResponse).thread.id),
          },
        );
        const binding: SessionBinding = {
          sessionId,
          nativeSessionId: opened,
          instanceId: spec.instanceId,
        };
        const state = buildNormalizingState(sessionId, opened, spec.outputSchema);
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
        // The native id is sent on this event because the controller has no
        // other way to learn it: a session started after the runner's hello
        // is not listed again.
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
        const held = yield* getHostedSession(sessionId);
        const running = held.turnId;
        const steered =
          running === undefined ? undefined : yield* steerTurn(held, input.text, running);
        const sent = steered ?? (yield* startTurn(held, input));
        // The turn counts as running from the reply, not from the
        // `turn/started` notification after it: an input arriving in between
        // would otherwise start a second turn.
        held.turnId = sent.turnId;
        for (const event of buildUserMessage({
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
        // No event is emitted here: the turn completing as `interrupted`
        // reports the interrupt.
        if (held === undefined) return Effect.void;
        // The turn is waiting on its unresolved requests, so they are all
        // cancelled first, with the closest reply each request's shape allows.
        // The waiting requests are cancelled before the open one, so that
        // resolving the open one does not open any of them.
        cancelWaiting(held);
        const open = held.open;
        // The open request is reported as resolved with `cancel`, because
        // the interrupt is what ended it.
        if (open !== undefined) resolvePark(held, open, "cancel");
        return interruptTurn(held);
      }),

    respondToRequest: (
      sessionId: string,
      requestId: string,
      decision: ApprovalDecision,
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        const held = sessions.get(sessionId);
        const park = held?.open;
        // Ignore a decision for a request that is not the open one, and a
        // decision the request did not offer: Codex would have to replace it
        // with something else.
        if (
          held === undefined ||
          park === undefined ||
          park.request.requestId !== requestId ||
          !park.request.decisions.includes(decision)
        ) {
          return Effect.void;
        }
        // A decision that ends the turn cancels every waiting request with it,
        // so none of them is shown to the user only to be cancelled at once.
        const ending = park.asked.endsTurn.includes(decision);
        if (ending) cancelWaiting(held);
        resolvePark(held, park, decision);
        // Interrupt only when the reply cannot express the decision itself;
        // every other row tells Codex to stop through its own reply.
        return ending ? interruptTurn(held) : Effect.void;
      }),

    stopSession: (sessionId: string, reason: ExitReason): Effect.Effect<void> =>
      Effect.suspend(() => {
        const held = sessions.get(sessionId);
        // A session whose thread the server unloaded, or whose app-server
        // died, has already exited: a second exit would record the same end
        // twice.
        if (held === undefined) return Effect.void;
        // The turn is interrupted before the session exits. Otherwise the
        // app-server would keep working in the workspace until it is killed,
        // and nobody would receive its notifications.
        return Effect.andThen(
          interruptTurn(held),
          Effect.sync(() => exitSession(held, reason)),
        );
      }),

    listSessions: Effect.sync(() => [...sessions.values()].map((held) => held.binding)),

    /**
     * Uses the device login rather than the browser login: the machine the
     * harness runs on usually has no browser, and the device login prints a
     * code the user can type into a browser anywhere. The login uses the
     * instance's own home directories, like a session does, so the credential
     * is saved where the app-server looks for it.
     */
    login: (ctx: ProviderRunnerContext, binary: string): LoginCommand => ({
      command: [binary, "login", "--device-auth"],
      env: prepareEnv(ctx),
      userCode: USER_CODE,
    }),

    install: makeCodexInstall(seam.run),
  };
};

export const codex: ProviderAdapter = makeCodexAdapter({
  appServer: spawnAppServer,
  run: runProcess,
});
