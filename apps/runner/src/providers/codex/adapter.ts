/**
 * The Codex adapter. It talks to Codex only through app-server connections,
 * and every file an app-server uses lives under the instance's own home
 * directory. Using the developer's own Codex directory would mix Hercule's
 * sessions with the user's login, skills and memory. A Thread on the local
 * runner is the one session that sees the user's own skills and instructions,
 * and even then nothing is written into the instance's Codex directory.
 */
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type {
  AccessMode,
  ApprovalDecision,
  ExitReason,
  ModelSelection,
  ProbeResult,
  ProviderEvent,
  QuestionAnswers,
  RequestResolution,
  SendResult,
  SessionBinding,
  SessionSpec,
  SubagentId,
} from "@hercule/protocol";
import type { LoginCommand } from "../login";
import type {
  AdapterTurnInput,
  ProviderAdapter,
  ProviderRunnerContext,
  UserMaterial,
} from "../index";
import { appendAttachmentPaths } from "../attachments";
import { buildFailedProbe } from "../probe";
import { buildUserMessage } from "../events";
import { runProcess, spawnAppServer, type Run } from "../process";
import { truncateMessage } from "../text";
import { now } from "../../report";
import { ASKED } from "./approvals";
import { normalize, readChangedPaths } from "./normalize";
import {
  makeCodexThreads,
  readCodexThreadId,
  type CodexThreads,
  type Park,
  type CodexThreadFrame,
  type CodexThreadState,
} from "./threads";
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
  type RpcReply,
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
  TurnInterruptParams,
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

/** One session and every Codex thread its app-server runs. */
interface Held {
  readonly binding: SessionBinding;
  readonly host: Host;
  readonly threads: CodexThreads;
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
 * a session's frames one at a time, in order, so without this timeout an
 * app-server that stops replying would hold up every later frame of its
 * session.
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

/**
 * Builds the developer instructions for one thread. A Codex thread accepts only
 * one set of instructions, so the parts are joined with a blank line between
 * them, in this order:
 *
 * - the session's system prompt;
 * - the user's own instructions, for a Thread that sees the user's material;
 * - the skill.
 *
 * A missing or empty part is left out, so the text never starts with a blank
 * line or has two blank lines in a row.
 */
const buildDeveloperInstructions = (
  systemPrompt: string | undefined,
  userInstructions: string | undefined,
  skill: string,
): string =>
  [systemPrompt, userInstructions, skill]
    .filter((part) => part !== undefined && part !== "")
    .join("\n\n");

/**
 * Reads the user's own instructions file. Returns its text, or `undefined`
 * when the session does not see the user's material or the user has no file.
 * Never fails: when the path is not a regular file or cannot be read, it logs
 * a warning with the path and the reason, never the file's text, and returns
 * `undefined`. A Thread never fails to start because of the user's own files
 * (spec 06 section 9.1).
 *
 * The file is read again every time a thread is opened, so a resumed or
 * forked thread gets the current text.
 */
const readUserInstructions = (
  material: UserMaterial | undefined,
): Effect.Effect<string | undefined> => {
  const path = material?.instructionsFile;
  if (path === undefined) return Effect.succeed(undefined);
  return Effect.try({
    try: () => {
      if (!statSync(path).isFile()) throw new Error("it is not a regular file");
      return readFileSync(path, "utf8");
    },
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  }).pipe(
    Effect.catch((reason) =>
      Effect.as(
        Effect.logWarning(`Did not read ${path} into the Thread's instructions: ${reason}`),
        undefined,
      ),
    ),
  );
};

/**
 * Builds the items Codex takes as a turn's input: the text first, with a line
 * per image naming the file it is saved in, then one `localImage` item per
 * image. Codex reads each image from that file itself, so its bytes never
 * cross the app-server's pipe.
 */
const buildUserInput = (input: AdapterTurnInput): Array<UserInput> => [
  { type: "text", text: appendAttachmentPaths(input.text, input.attachments), text_elements: [] },
  ...(input.attachments ?? []).map((attachment): UserInput => ({
    type: "localImage",
    path: attachment.path,
  })),
];

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

  /** Returns only the current session hosted by this exact process. */
  const findHostSession = (host: Host): Held | undefined => {
    const held = host.sessionId === undefined ? undefined : sessions.get(host.sessionId);
    return held?.host === host ? held : undefined;
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
    held.threads.close();
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
   * `codex` directory, and for a session that does not see the user's
   * material its `home` directory, if they are missing. `CODEX_HOME` alone
   * does not isolate a session: Codex also reads skills from `.agents/skills`
   * in the user's home directory, so `HOME` is moved to an empty directory of
   * the instance's own.
   *
   * A Thread that sees the user's material keeps the real `HOME`, so Codex
   * finds the user's skills there by itself. This is why the runner gives a
   * Codex Thread no skill paths (see `findCodexMaterial` in
   * `user-material/index.ts`). Changing `HOME` per session is safe because
   * every session has its own app-server process. A probe and a login never
   * see the user's material, so they always get the moved `HOME`.
   *
   * This is done here, not in the shared session context, because a moved
   * `HOME` breaks Claude's Keychain lookup.
   */
  const prepareEnv = (ctx: ProviderRunnerContext): Record<string, string | undefined> => {
    const codexHome = join(ctx.home, "codex");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    if (ctx.userMaterial !== undefined) return { ...ctx.env, CODEX_HOME: codexHome };
    const neutral = join(ctx.home, "home");
    mkdirSync(neutral, { recursive: true, mode: 0o700 });
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

  /** Delivers a known thread's frame without letting malformed vendor data stop the reader. */
  const dispatchCodexThreadFrame = (
    held: Held,
    thread: CodexThreadState,
    frame: CodexThreadFrame,
    cancelled: boolean,
  ): void => {
    try {
      if ("id" in frame) {
        openRequest(held, thread, frame, cancelled);
        return;
      }
      if (frame.method === "thread/closed") {
        if (thread === held.threads.root) exitSession(held, "idle_unload");
        return;
      }
      for (const event of normalize(thread.state, frame)) {
        if (event._tag !== "session.usage.updated") emit(event);
        else held.threads.recordUsage(thread, event);
      }
      if (frame.method === "item/started" || frame.method === "item/completed") {
        const { item } = frame.params as ItemStartedNotification | ItemCompletedNotification;
        if (item.type === "fileChange") {
          // Completed patches would otherwise keep their cached approval paths
          // for the rest of a long turn.
          if (frame.method === "item/completed") thread.fileChanges.delete(item.id);
          else thread.fileChanges.set(item.id, readChangedPaths(item));
        }
      }
    } catch {
      if (frame.method === "thread/tokenUsage/updated") {
        const missingBaseline = held.threads.rejectUsageReport(thread);
        warn(
          held.host,
          missingBaseline
            ? "The app-server sent an unreadable usage report. Usage is incomplete; the next usable report will establish a baseline."
            : "The app-server sent an unreadable usage report. Keeping the last usable counters until a valid report arrives.",
        );
        return;
      }
      if ("id" in frame)
        refuseRequest(held.host, frame, {
          code: INVALID_REQUEST,
          message: `Hercule could not read this ${frame.method} request`,
        });
      warn(held.host, `the app-server sent a ${frame.method} that this build could not read`);
    }
  };

  const onNotification = (host: Host, frame: NotificationFrame): void => {
    findHostSession(host)?.threads.receive(frame);
  };

  /** Resolves one Request under its asking thread and native RPC id. */
  const resolvePark = (
    held: Held,
    thread: CodexThreadState,
    park: Park,
    reply: RpcReply,
    resolution: RequestResolution,
    reportResolution = true,
  ): void => {
    thread.parks.delete(park.request.requestId);
    held.host.rpc.answer(park.id, reply);
    if (reportResolution)
      emit({
        _tag: "request.resolved",
        eventId: crypto.randomUUID(),
        sessionId: held.binding.sessionId,
        at: now(),
        requestId: park.request.requestId,
        ...(thread.state.subagentId === undefined ? {} : { subagentId: thread.state.subagentId }),
        ...resolution,
      });
  };

  /** Cancels only the Requests of the thread whose work ended. */
  const cancelRequests = (held: Held, thread: CodexThreadState, reportResolution = true): void => {
    for (const park of [...thread.parks.values()])
      resolvePark(
        held,
        thread,
        park,
        park.asked.replies("cancel", park.params),
        { decision: "cancel" },
        reportResolution,
      );
  };

  /** Finds a Request in this session, regardless of which agent asked first. */
  const findOpenPark = (sessionId: string, requestId: string) => {
    const held = sessions.get(sessionId);
    const found = held?.threads.findRequest(requestId);
    return held === undefined || found === undefined ? undefined : { held, ...found };
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
    const held = findHostSession(host);
    const threadId = readCodexThreadId(frame);
    if (threadId === undefined || held === undefined) {
      refuseRequest(host, frame, {
        code: INVALID_REQUEST,
        message: `no session on this runner is on thread ${String(threadId)}`,
      });
      return;
    }
    held.threads.receive(frame);
  };

  /** Publishes every Request immediately, with the identity of its asker. */
  const openRequest = (
    held: Held,
    thread: CodexThreadState,
    frame: ServerRequestFrame,
    cancelled: boolean,
  ): void => {
    const asked = ASKED[frame.method]!;
    const request = asked.opens(frame.params, {
      requestId: crypto.randomUUID(),
      threadId: thread.state.threadId,
      paths: (itemId) => thread.fileChanges.get(itemId) ?? [],
    });
    const park: Park = { id: frame.id, request, asked, params: frame.params };
    thread.parks.set(request.requestId, park);
    emit({
      _tag: "request.opened",
      eventId: crypto.randomUUID(),
      sessionId: held.binding.sessionId,
      at: now(),
      request,
      ...(thread.state.subagentId === undefined ? {} : { subagentId: thread.state.subagentId }),
    });
    if (cancelled)
      resolvePark(held, thread, park, park.asked.replies("cancel", park.params), {
        decision: "cancel",
      });
  };

  /** Interrupts only this thread's native turn, within the control deadline. */
  const interruptTurn = (
    held: Held,
    thread: CodexThreadState,
    turnId = thread.turnId,
  ): Effect.Effect<void> =>
    turnId === undefined
      ? Effect.void
      : Effect.ignore(
          Effect.timeout(
            held.host.rpc.request("turn/interrupt", {
              threadId: thread.state.threadId,
              turnId,
            } satisfies TurnInterruptParams),
            CONTROL_DEADLINE,
          ),
        );

  /** Cancels a thread's Requests before stopping the turn that asked them. */
  const stopCodexThread = (held: Held, thread: CodexThreadState): Effect.Effect<void> =>
    Effect.suspend(() => {
      cancelRequests(held, thread);
      return interruptTurn(held, thread);
    });

  /** Stops selected threads together, so a silent child cannot delay its siblings. */
  const stopCodexThreads = (held: Held, subagentId?: SubagentId): Effect.Effect<void> =>
    Effect.forEach(held.threads.cancelWork(subagentId), (thread) => stopCodexThread(held, thread), {
      concurrency: "unbounded",
      discard: true,
    });

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
  const startTurn = (held: Held, input: AdapterTurnInput): Effect.Effect<SendResult, string> =>
    Effect.gen(function* () {
      // Codex takes the schema per turn, not per thread, so every turn of the
      // session sends it. If it were sent only once, the second turn of an
      // Agent's session would answer in prose.
      const schema = held.threads.root.state.outputSchema;
      const params: TurnStartParams = {
        threadId: held.binding.nativeSessionId,
        input: buildUserInput(input),
        ...buildModelParams(input.modelSelection),
        // The cast is safe because nothing here reads the value back. The
        // schema crosses the wire as the JSON the controller stored, and
        // Codex's own JSON type is the mutable type ts-rs writes.
        ...(schema === undefined ? {} : { outputSchema: schema as JsonValue }),
      };
      // The normalizer reports this model on `turn.started`, because the
      // notification has no model. It is set before the request is sent,
      // because `turn/started` can arrive before this fiber resumes.
      const before = held.threads.root.state.model;
      if (input.modelSelection !== undefined)
        held.threads.root.state.model = input.modelSelection.model;
      const answer = yield* Effect.mapError(
        retryWhileOverloaded(held.host.rpc.request("turn/start", params)),
        (error) => {
          // No turn started, so restore the previous model for the next turn
          // to report.
          held.threads.root.state.model = before;
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
    input: AdapterTurnInput,
    expectedTurnId: string,
  ): Effect.Effect<SendResult | undefined> =>
    Effect.match(
      retryWhileOverloaded(
        held.host.rpc.request("turn/steer", {
          threadId: held.binding.nativeSessionId,
          input: buildUserInput(input),
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
   * system prompt, the user's own instructions and the skill are sent as
   * developer instructions, which all three methods accept (spec 06 section
   * 9.3). No `AGENTS.md` is written, so the scratch directory a session runs
   * in stays empty.
   *
   * The user's instructions go in the developer instructions rather than into
   * the instance's Codex directory. Codex reads an `AGENTS.md` there for every
   * session and has no setting to turn that off, and every session of the
   * instance shares that directory, so a file there would reach assistant
   * sessions and workflow steps too.
   *
   * Nothing in this adapter reads `disallowedTools`. Codex cannot restrict
   * tools, and the Agent record and the Session record both report the field
   * as not enforced, so no behaviour is silently substituted.
   */
  const buildThreadParams = (
    spec: SessionSpec,
    ctx: ProviderRunnerContext,
    userInstructions: string | undefined,
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
      developerInstructions: buildDeveloperInstructions(
        spec.systemPrompt,
        userInstructions,
        ctx.herculeTool.skill,
      ),
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
        const userInstructions = yield* readUserInstructions(ctx.userMaterial);
        const host = yield* startSessionHost(sessionId, ctx, binary);
        const carried = spec.continue;
        const opened = yield* Effect.matchEffect(
          carried === undefined
            ? host.rpc.request("thread/start", {
                ...buildThreadParams(spec, ctx, userInstructions),
                ephemeral: false,
              } satisfies ThreadStartParams)
            : host.rpc.request(carried.mode === "resume" ? "thread/resume" : "thread/fork", {
                threadId: carried.nativeSessionId,
                ...buildThreadParams(spec, ctx, userInstructions),
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
        const held: Held = {
          binding,
          host,
          threads: makeCodexThreads({
            sessionId,
            rootThreadId: opened,
            spec,
            rpc: host.rpc,
            emit,
            dispatch: (thread, frame, cancelled) =>
              dispatchCodexThreadFrame(held, thread, frame, cancelled),
            interrupt: (thread, turnId) => interruptTurn(held, thread, turnId),
            cancelRequests: (thread) => cancelRequests(held, thread),
            completeTurn: (thread) => {
              // The turn event closes the controller's Requests. Native RPCs
              // still need replies, without duplicate resolution events.
              cancelRequests(held, thread, false);
              thread.fileChanges.clear();
            },
            failSession: () => exitSession(held, "crash"),
          }),
        };
        sessions.set(sessionId, held);
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

    sendInput: (sessionId: string, input: AdapterTurnInput): Effect.Effect<SendResult, string> =>
      Effect.gen(function* () {
        const held = yield* getHostedSession(sessionId);
        const ticket = held.threads.beginInput();
        const sent = yield* Effect.onExit(
          Effect.gen(function* () {
            yield* held.threads.prepareUsage;
            const running = held.threads.root.turnId;
            yield* held.threads.submitInput(ticket, running);
            const steered =
              running === undefined ? undefined : yield* steerTurn(held, input, running);
            if (steered !== undefined) return steered;
            yield* held.threads.submitInput(ticket);
            return yield* startTurn(held, input);
          }),
          () => Effect.sync(() => held.threads.finishInput(ticket)),
        );
        // The turn counts as running from the reply, not from the
        // `turn/started` notification after it: an input arriving in between
        // would otherwise start a second turn.
        held.threads.acceptInput(ticket, sent.turnId);
        for (const event of sessions.get(sessionId) !== held
          ? []
          : buildUserMessage({
              sessionId,
              turnId: sent.turnId,
              text: input.text,
              attachments: input.attachments,
              steered: sent.delivery === "steered",
              providerRefs: { threadId: held.binding.nativeSessionId },
            })) {
          emit(event);
        }
        return sent;
      }),

    interrupt: (sessionId: string, subagentId?: SubagentId): Effect.Effect<void> =>
      Effect.suspend(() => {
        const held = sessions.get(sessionId);
        return held === undefined ? Effect.void : stopCodexThreads(held, subagentId);
      }),

    respondToApprovalRequest: (
      sessionId: string,
      requestId: string,
      decision: ApprovalDecision,
    ): Effect.Effect<void> =>
      Effect.suspend(() => {
        const found = findOpenPark(sessionId, requestId);
        // A decision the approval did not offer is ignored: Codex would have
        // to replace it with something else.
        if (
          found === undefined ||
          found.park.request.kind === "question" ||
          !found.park.request.decisions.includes(decision)
        ) {
          return Effect.void;
        }
        const { held, thread, park } = found;
        if (decision === "cancel") held.threads.cancelAskingTurn(thread);
        resolvePark(held, thread, park, park.asked.replies(decision, park.params), { decision });
        // Cancel ends the asking agent alone. The explicit Stop operation is
        // the operation that also stops descendants.
        if (decision === "cancel") cancelRequests(held, thread);
        return park.asked.endsTurn.includes(decision) ? interruptTurn(held, thread) : Effect.void;
      }),

    respondToQuestion: (
      sessionId: string,
      requestId: string,
      answers: QuestionAnswers,
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        const found = findOpenPark(sessionId, requestId);
        const reply =
          found?.park.request.kind === "question"
            ? found.park.asked.answers?.(answers, found.park.params)
            : undefined;
        if (found === undefined || reply === undefined) return;
        resolvePark(found.held, found.thread, found.park, reply, { answers });
      }),

    stopSession: (sessionId: string, reason: ExitReason): Effect.Effect<void> =>
      Effect.suspend(() => {
        const held = sessions.get(sessionId);
        // A session whose thread the server unloaded, or whose app-server
        // died, has already exited: a second exit would record the same end
        // twice.
        if (held === undefined) return Effect.void;
        held.threads.beginClosing();
        // The turn is interrupted before the session exits. Otherwise the
        // app-server would keep working in the workspace until it is killed,
        // and nobody would receive its notifications.
        return Effect.andThen(
          stopCodexThreads(held),
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
