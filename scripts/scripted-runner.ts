/**
 * A runner that follows a script instead of running agents. It joins a real
 * controller and dials it over the runner protocol, as `hercule runner` does,
 * and then reports whatever session state a caller asks for. The desktop
 * end-to-end suite and the desktop perf script use it, through
 * `e2e/desktop/fleet.ts`, to put threads in known states without a harness,
 * a model or a login.
 *
 * It answers the controller on its own, the way a healthy runner does:
 *
 * - a ping with a pong;
 * - a probe with a logged-in report that offers one model;
 * - a workspace provision with `ready`, and a dispose with `deleted`;
 * - a session start with `session.started`, unless starts are held;
 * - an input by starting a turn, which runs until the caller completes it,
 *   so a spawned thread settles busy, unless the session is set to crash on it;
 * - a stop with `session.exited` for the reason `stopped`;
 * - an interrupt by ending the running turn as `interrupted`;
 * - a response to the open Request with `request.resolved`.
 *
 * Nothing else happens until the caller calls a method.
 *
 * Like `controller-process.ts`, it uses only Node's APIs, imports nothing from
 * a test framework, and uses only TypeScript that Node can strip, because the
 * perf script runs it on plain Node. It imports only types from the protocol
 * package, so the compiler checks every frame it writes against the protocol.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  ApprovalDecision,
  ControllerToRunner,
  ExitReason,
  JoinAnswer,
  OpenRequest,
  ProbeResult,
  ProviderEvent,
  RunnerFacts,
  RunnerToController,
  SessionBinding,
  TurnState,
} from "../packages/protocol/src/index";

/** Written by hand because only types are imported; a mismatch fails the handshake loudly. */
const PROTOCOL_VERSION = 1;

/** The most sessions a runner may list in one report, as the protocol allows. */
const MAX_REPORTED_SESSIONS = 256;

/**
 * A Mac with Claude Code installed. The fleet places threads on the Claude
 * Code instance, so the facts say its harness is present, and a screen that
 * checks for it shows the runner as healthy.
 */
const FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 64 * 1024 ** 3,
  docker: false,
  toolchains: [],
  providers: [{ name: "claude", present: true, path: "/usr/local/bin/claude" }],
  adapters: ["claude-code"],
  identityPort: 4939,
};

const PROBE_RESULT: ProbeResult = {
  harnessVersion: "1.0.0",
  auth: { status: "ok" },
  models: [{ slug: "scripted", name: "Scripted", isDefault: true, options: [] }],
};

const APPROVAL_DECISIONS = ["allow", "allow_always", "deny", "cancel"] as const;

/** The kinds of Request a harness can open. */
export type RequestKind = OpenRequest["kind"];

/**
 * The WebSocket constructor with the options argument that Node and Bun
 * accept. The DOM's type has no `headers`, because a browser cannot set them,
 * and the desktop end-to-end suite compiles with the DOM library.
 */
const WebSocketWithHeaders = WebSocket as unknown as new (
  url: string,
  init: { readonly headers: Record<string, string> },
) => WebSocket;

/** A session the runner holds: its start has arrived and it has not exited. */
interface HostedSession {
  readonly instanceId: string;
  /** The sequence number of the last event sent. A new process numbers from 1 again. */
  seq: number;
  /** False while the start is held, until `startSession` reports it. */
  started: boolean;
  /** The provider-native id that makes the session resumable; absent when it is not. */
  nativeSessionId: string | undefined;
  /** The turn that is running, if any. */
  turnId: string | undefined;
  /** The Request the session is parked on, if any. */
  requestId: string | undefined;
}

/** A scripted runner, joined to a controller and connected to it. */
export interface ScriptedRunner {
  readonly runnerId: string;
  /**
   * Holds every session start that arrives from now on: the session stays
   * `starting` until `startSession` reports it.
   */
  readonly holdStarts: () => void;
  /**
   * Reports a held start as started. The session becomes idle, and the
   * controller then delivers the spawn's prompt, which starts a turn.
   *
   * A resumable session reports a provider-native id; the default is
   * resumable, like a real harness. A session that is not resumable exits
   * for good, and is dropped by a `reconnect`. Waits up to 5 s for the start
   * to arrive, and fails if it does not.
   */
  readonly startSession: (
    sessionId: string,
    options?: { readonly resumable?: boolean },
  ) => Promise<void>;
  /** Starts a turn, which makes the session busy. Fails if a turn is already running. */
  readonly startTurn: (sessionId: string) => void;
  /** Completes the running turn, which makes the session idle. Fails if no turn is running. */
  readonly completeTurn: (sessionId: string) => void;
  /**
   * Opens a Request of the given kind and returns its id. A harness asks
   * during a turn, so the session is realistic only when it is busy.
   */
  readonly openRequest: (sessionId: string, kind: RequestKind) => string;
  /**
   * Resolves the open Request with a decision, as a harness does when it
   * withdraws the question. Fails if no Request is open.
   */
  readonly resolveRequest: (sessionId: string, decision: ApprovalDecision) => void;
  /** Ends the session for the given reason. The runner no longer holds it. */
  readonly endSession: (sessionId: string, reason: ExitReason) => void;
  /**
   * Makes the session crash when its next input arrives, before it answers
   * the input or starts a turn, as a process stuck in a crash loop does. The
   * session may be exited when this is called: the next input is then the one
   * that resumes it.
   *
   * This is how a thread reaches the crash-loop guard (`resumeHeld`): the
   * resumed process exits before any turn while an input still waits. A
   * thread's queued input is cancelled when it exits, so only the input left
   * unanswered keeps the thread held, and only until the controller stops
   * waiting for the answer (10 s) and cancels that input too.
   */
  readonly crashSessionOnNextInput: (sessionId: string) => void;
  /**
   * Shuts down the way a runner does when it is stopped: it says goodbye and
   * closes its connection, so the controller shows the runner `offline`.
   */
  readonly goOffline: () => Promise<void>;
  /**
   * Closes the connection without a goodbye, like a machine that lost its
   * network, so the controller shows the runner `unreachable`.
   */
  readonly goUnreachable: () => Promise<void>;
  /**
   * Connects again with the same credential and reports the sessions it
   * still holds. A session without a provider-native id cannot be listed in
   * that report, so the controller ends it as `runner_restart`; the runner
   * drops it too. Fails if the runner holds more sessions than one report
   * may list.
   */
  readonly reconnect: () => Promise<void>;
}

/**
 * Joins the controller at `url` with a join token, connects, and reports that
 * it holds no sessions yet. Returns the runner once the controller has
 * answered its hello, so the runner is already online. Fails if the join is
 * refused or the controller does not answer the hello within 5 s.
 */
export async function enlistScriptedRunner(
  url: string,
  joinToken: string,
): Promise<ScriptedRunner> {
  const joined = await fetch(`${url}/api/v1/runners/join`, {
    method: "POST",
    headers: { authorization: `Bearer ${joinToken}`, "content-type": "application/json" },
    body: "{}",
  });
  if (joined.status !== 201) {
    throw new Error(`the controller refused the join (${joined.status}): ${await joined.text()}`);
  }
  const { runnerId, credential } = (await joined.json()) as JoinAnswer;

  const sessions = new Map<string, HostedSession>();
  /** Sessions that crash on their next input. Kept apart from `sessions`, which a resume replaces. */
  const crashing = new Set<string>();
  let holding = false;
  let socket: WebSocket;
  /** The code and reason of the last close, so a send on a closed connection can say why. */
  let lastClose: string | undefined;

  const send = (frame: RunnerToController): void => {
    if (socket.readyState !== WebSocket.OPEN) {
      throw new Error(`runner ${runnerId} is not connected; it closed with ${lastClose}`);
    }
    socket.send(JSON.stringify(frame));
  };

  const findSession = (sessionId: string): HostedSession => {
    const session = sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`runner ${runnerId} holds no session ${sessionId}`);
    }
    return session;
  };

  /** Sends one event of a session with the session's next sequence number. */
  const reportEvent = (session: HostedSession, event: ProviderEvent): void => {
    session.seq += 1;
    send({ _tag: "sessionEvent", seq: session.seq, event });
  };

  /** Returns the fields every event carries. */
  const stampEvent = (sessionId: string) => ({
    eventId: randomUUID(),
    sessionId,
    at: new Date().toISOString(),
  });

  const reportStarted = (sessionId: string, resumable: boolean): void => {
    const session = findSession(sessionId);
    const nativeSessionId = resumable ? `native-${sessionId}` : undefined;
    session.started = true;
    session.nativeSessionId = nativeSessionId;
    reportEvent(session, {
      _tag: "session.started",
      ...stampEvent(sessionId),
      ...(nativeSessionId === undefined ? {} : { providerRefs: { nativeSessionId } }),
    });
  };

  const startTurn = (sessionId: string): void => {
    const session = findSession(sessionId);
    if (session.turnId !== undefined) {
      throw new Error(`session ${sessionId} is already running turn ${session.turnId}`);
    }
    session.turnId = randomUUID();
    reportEvent(session, {
      _tag: "turn.started",
      ...stampEvent(sessionId),
      turnId: session.turnId,
    });
  };

  /** Ends the running turn in the given state. Fails if no turn is running. */
  const completeTurn = (sessionId: string, state: TurnState): void => {
    const session = findSession(sessionId);
    if (session.turnId === undefined) {
      throw new Error(`session ${sessionId} has no running turn to complete`);
    }
    const turnId = session.turnId;
    session.turnId = undefined;
    reportEvent(session, { _tag: "turn.completed", ...stampEvent(sessionId), turnId, state });
  };

  const reportRequestResolved = (
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): void => {
    const session = findSession(sessionId);
    session.requestId = undefined;
    reportEvent(session, {
      _tag: "request.resolved",
      ...stampEvent(sessionId),
      requestId,
      decision,
    });
  };

  const endSession = (sessionId: string, reason: ExitReason): void => {
    const session = findSession(sessionId);
    reportEvent(session, { _tag: "session.exited", ...stampEvent(sessionId), reason });
    sessions.delete(sessionId);
  };

  const answerFrame = (frame: ControllerToRunner): void => {
    switch (frame._tag) {
      case "ping":
        return send({ _tag: "pong" });
      case "probeRequest":
        return send({
          _tag: "probeReport",
          requestId: frame.requestId,
          instanceId: frame.instanceId,
          result: PROBE_RESULT,
        });
      case "workspaceProvision":
        return send({
          _tag: "workspaceReport",
          workspaceId: frame.workspaceId,
          status: "ready",
          checkouts: frame.checkouts.map((checkout) => ({
            checkoutId: checkout.checkoutId,
            branch: checkout.branch ?? "main",
            branches: checkout.branch === null ? ["main"] : ["main", checkout.branch],
            defaultBranch: "main",
          })),
        });
      case "workspaceDispose":
        return send({ _tag: "workspaceReport", workspaceId: frame.workspaceId, status: "deleted" });
      case "sessionStart":
        // A resume starts the same session id again, as a new process.
        sessions.set(frame.sessionId, {
          instanceId: frame.spec.instanceId,
          seq: 0,
          started: false,
          nativeSessionId: undefined,
          turnId: undefined,
          requestId: undefined,
        });
        if (!holding) reportStarted(frame.sessionId, true);
        return;
      case "sessionInput": {
        const session = sessions.get(frame.sessionId);
        if (session === undefined) {
          return send({
            _tag: "sessionInputResult",
            requestId: frame.requestId,
            ok: false,
            message: `runner ${runnerId} holds no session ${frame.sessionId}`,
          });
        }
        if (crashing.delete(frame.sessionId)) return endSession(frame.sessionId, "crash");
        const running = session.turnId !== undefined;
        send({
          _tag: "sessionInputResult",
          requestId: frame.requestId,
          ok: true,
          delivery: running ? "steered" : "opened",
        });
        if (!running) startTurn(frame.sessionId);
        return;
      }
      // A frame can cross a session's exit on the wire: the controller sends it
      // before it has handled the `session.exited` this runner already sent.
      // A real runner ignores a frame for a session it no longer holds.
      case "sessionStop":
        if (!sessions.has(frame.sessionId)) return;
        return endSession(frame.sessionId, "stopped");
      case "sessionRespond":
        // A late answer to an earlier Request must not resolve the one open now.
        if (sessions.get(frame.sessionId)?.requestId !== frame.requestId) return;
        return reportRequestResolved(frame.sessionId, frame.requestId, frame.decision);
      case "sessionInterrupt": {
        const session = sessions.get(frame.sessionId);
        if (session?.turnId === undefined) return;
        return completeTurn(frame.sessionId, "interrupted");
      }
      default:
        // Every other frame asks for work a scripted runner does not do.
        return;
    }
  };

  /**
   * Opens the socket, sends the hello, and resolves once the controller has
   * answered it. Frames before that answer are dropped, as a real runner
   * drops them.
   */
  const dial = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const opened = new WebSocketWithHeaders(
        `${url.replace(/^http/, "ws")}/api/v1/runners/socket`,
        { headers: { authorization: `Bearer ${credential}` } },
      );
      let greeted = false;
      const timer = setTimeout(() => {
        opened.close();
        reject(new Error(`the controller did not answer runner ${runnerId}'s hello`));
      }, 5_000);
      opened.onopen = () => {
        opened.send(
          JSON.stringify({
            _tag: "runnerHello",
            protocolVersion: PROTOCOL_VERSION,
            capabilities: [],
            binaryVersion: "0.1.0",
            nonce: randomBytes(16).toString("base64"),
            facts: FACTS,
          } satisfies RunnerToController),
        );
      };
      opened.onmessage = (message) => {
        const frame = JSON.parse(String(message.data)) as ControllerToRunner;
        if (greeted) return answerFrame(frame);
        if (frame._tag !== "controllerHello") return;
        greeted = true;
        clearTimeout(timer);
        socket = opened;
        resolve();
      };
      opened.onclose = (event) => {
        clearTimeout(timer);
        lastClose = `${event.code} ${event.reason}`;
        if (!greeted) reject(new Error(`the controller closed the connection: ${lastClose}`));
      };
    });

  /** Closes the connection and waits until it is closed, so the controller has seen it go. */
  const closeSocket = async (): Promise<void> => {
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((resolve) => socket.addEventListener("close", resolve));
    socket.close();
    await closed;
  };

  await dial();
  send({ _tag: "sessionsReport", sessions: [] });

  return {
    runnerId,
    holdStarts: () => {
      holding = true;
    },
    startSession: async (sessionId, options = {}) => {
      const deadline = Date.now() + 5_000;
      while (!sessions.has(sessionId)) {
        if (Date.now() > deadline) {
          throw new Error(`the start of session ${sessionId} never reached runner ${runnerId}`);
        }
        await sleep(10);
      }
      if (findSession(sessionId).started) {
        throw new Error(`session ${sessionId} has started already: call holdStarts first`);
      }
      reportStarted(sessionId, options.resumable ?? true);
    },
    startTurn,
    completeTurn: (sessionId) => completeTurn(sessionId, "completed"),
    openRequest: (sessionId, kind) => {
      const session = findSession(sessionId);
      const request = buildOpenRequest(kind);
      session.requestId = request.requestId;
      reportEvent(session, { _tag: "request.opened", ...stampEvent(sessionId), request });
      return request.requestId;
    },
    resolveRequest: (sessionId, decision) => {
      const requestId = findSession(sessionId).requestId;
      if (requestId === undefined) {
        throw new Error(`session ${sessionId} has no open Request to resolve`);
      }
      reportRequestResolved(sessionId, requestId, decision);
    },
    endSession,
    crashSessionOnNextInput: (sessionId) => {
      crashing.add(sessionId);
    },
    goOffline: async () => {
      if (socket.readyState === WebSocket.OPEN) send({ _tag: "goodbye" });
      await closeSocket();
    },
    goUnreachable: closeSocket,
    reconnect: async () => {
      const bindings: Array<SessionBinding> = [];
      for (const [sessionId, session] of sessions) {
        if (session.nativeSessionId === undefined) sessions.delete(sessionId);
        else {
          bindings.push({
            sessionId,
            nativeSessionId: session.nativeSessionId,
            instanceId: session.instanceId,
          });
        }
      }
      if (bindings.length > MAX_REPORTED_SESSIONS) {
        throw new Error(
          `runner ${runnerId} holds ${bindings.length} sessions, and one report lists at most ` +
            `${MAX_REPORTED_SESSIONS}: spread the threads over more runners`,
        );
      }
      await dial();
      send({ _tag: "sessionsReport", sessions: bindings });
    },
  };
}

/**
 * Builds a Request of the given kind, with the details a harness would send.
 * A question offers only deny and cancel, like the real adapters, which cannot
 * send an answer back yet.
 */
function buildOpenRequest(kind: RequestKind): OpenRequest {
  const identity = { requestId: randomUUID(), itemId: randomUUID() };
  switch (kind) {
    case "command_approval":
      return { ...identity, kind, decisions: APPROVAL_DECISIONS, detail: { command: "pnpm test" } };
    case "file_change_approval":
      return {
        ...identity,
        kind,
        decisions: APPROVAL_DECISIONS,
        detail: { paths: ["src/index.ts"] },
      };
    case "file_read_approval":
      return { ...identity, kind, decisions: APPROVAL_DECISIONS, detail: { paths: [".env"] } };
    case "tool_approval":
      return { ...identity, kind, decisions: APPROVAL_DECISIONS, detail: { toolName: "WebFetch" } };
    case "question":
      return {
        ...identity,
        kind,
        decisions: ["deny", "cancel"],
        detail: {
          questions: [
            {
              question: "Which database should the service use?",
              header: "Database",
              options: [
                { label: "SQLite", description: "One file, no server to run." },
                { label: "Postgres", description: "A server, for many writers at once." },
              ],
              multiSelect: false,
            },
          ],
        },
      };
  }
}
