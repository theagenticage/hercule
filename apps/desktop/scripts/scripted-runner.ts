/**
 * A runner that follows a script instead of running agents. It joins a real
 * controller and dials it over the runner protocol, as `hercule runner` does,
 * and then reports whatever session state a caller asks for. The desktop
 * end-to-end suite and the desktop perf script use it, through
 * `apps/desktop/scripts/fleet.ts`, to put threads in known states without a
 * harness, a model or a login.
 *
 * It answers the controller on its own, the way a healthy runner does:
 *
 * - a ping with a pong;
 * - a probe with a logged-in report that offers two models, each with a
 *   reasoning effort and a fast mode;
 * - a workspace provision with `ready`, and a dispose with `deleted`;
 * - a session start with `session.started`;
 * - an input by starting a turn and reporting the user's message in it, or,
 *   while a turn runs, by reporting the message as steered into that turn.
 *   A turn runs until the caller or a script ends it, so a spawned thread
 *   settles busy;
 * - a stop with `session.exited` for the reason `stopped`;
 * - an interrupt by withdrawing the open Request, if any, and ending the
 *   running turn as `interrupted`;
 * - a response to the open Request with `request.resolved`.
 *
 * Nothing else happens until the caller calls a method. The simple methods
 * each report one change: a turn starts, a Request opens, the session exits.
 * `playScript` reports a whole turn's work instead: messages that stream word
 * by word, and tool calls that may ask for approval and wait for the user to
 * allow them. It reports the same events, with the same details, that the
 * Claude Code adapter in `apps/runner/src/providers` reports for that work, so
 * a screen sees what it would see from a real agent.
 *
 * Like the root `scripts/controller-process.ts`, it uses only Node's APIs,
 * imports nothing from a test framework, and uses only TypeScript that Node
 * can strip, because the perf script runs it on plain Node. It imports only
 * types from the protocol package, so the compiler checks every frame it
 * writes against the protocol.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Schema } from "effect";
import { pollUntil } from "./poll.ts";
import type {
  ApprovalDecision,
  ControllerToRunner,
  ExitReason,
  ItemKind,
  JoinAnswer,
  ModelOption,
  OpenRequest,
  PROTOCOL_VERSION,
  ProbeResult,
  ProviderEvent,
  RunnerFacts,
  RunnerToController,
  SessionBinding,
  TurnState,
} from "../../../packages/protocol/src/index";

/** The most sessions a runner may list in one report, as the protocol allows. */
const MAX_REPORTED_SESSIONS = 256;

/**
 * A Mac with Claude Code installed. The fleet places threads on the Claude
 * Code instance, so the facts say its harness is present, and a screen that
 * checks for it shows the runner as healthy. The identity port is the
 * caller's to choose; see `enlistScriptedRunner`.
 */
const FACTS: Omit<RunnerFacts, "identityPort"> = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 64 * 1024 ** 3,
  docker: false,
  toolchains: [],
  providers: [{ name: "claude", present: true, path: "/usr/local/bin/claude" }],
  adapters: ["claude-code"],
};

/**
 * The options each scripted model offers, shaped like the Claude Code
 * adapter's: a reasoning effort to pick from, and a fast mode to switch on.
 */
const MODEL_OPTIONS: ReadonlyArray<ModelOption> = [
  {
    id: "effort",
    label: "Reasoning effort",
    kind: "select",
    choices: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
    default: "medium",
  },
  { id: "fastMode", label: "Fast mode", kind: "boolean", default: false },
];

/**
 * A logged-in report with two models, so a test can pick a model other than
 * the default, and options on both, so it can pick an option.
 */
const PROBE_RESULT: ProbeResult = {
  harnessVersion: "1.0.0",
  auth: { status: "ok" },
  models: [
    { slug: "scripted", name: "Scripted", isDefault: true, options: MODEL_OPTIONS },
    { slug: "scripted-large", name: "Scripted Large", options: MODEL_OPTIONS },
  ],
};

const APPROVAL_DECISIONS = ["allow", "allow_always", "deny", "cancel"] as const;

/** The tool result a scripted tool call reports when it succeeds. */
const TOOL_OUTPUT = "ok";

/** How long a `message` step waits between two words, by default. */
const WORD_DELAY_MS = 20;

/** How long a `stream` step waits between two deltas, by default. */
const STREAM_DELAY_MS = 2;

/**
 * The Markdown a `stream` step repeats: a heading, a paragraph, a list and a
 * code block, so a long message exercises every block the thread view renders.
 * Each block ends with a blank line, so the blocks can follow each other in
 * any number.
 */
const STREAM_BLOCKS: ReadonlyArray<string> = [
  "## Where the time goes\n\n",
  "The controller keeps the deltas of one item in a buffer and writes a row " +
    "once the buffer holds 4 KiB, so a long answer costs a handful of writes " +
    "rather than one per word. The page renders every delta as it arrives.\n\n",
  "- The sidebar re-renders only the row whose status changed.\n" +
    "- The transcript appends to the open block instead of parsing the whole message again.\n" +
    "- A code block is highlighted once it is closed.\n\n",
  "```ts\nconst rows = await readTranscript(sessionId);\nfor (const row of rows) {\n" +
    "  renderRow(row);\n}\n```\n\n",
];

/** The kinds of Request a harness can open. */
export type RequestKind = OpenRequest["kind"];

/**
 * One piece of work in a scripted turn. `playScript` plays a list of steps in
 * order into the session's running turn. Each step reports the events the
 * Claude Code adapter reports for the same work:
 *
 * - `message` streams `text` as an assistant message item, one delta per
 *   word, `deltaMs` apart (20 by default).
 * - `stream` streams one long assistant message of generated Markdown, one
 *   delta per word, `deltaMs` apart (2 by default), for `forMs`. It stops at
 *   the first block boundary after that, so the Markdown is never cut off
 *   inside a code block.
 * - `command` and `file_change` report a tool call as Claude Code's `Bash`
 *   and `Edit`. The call runs for `forMs` (0 by default) and succeeds. With
 *   `ask`, it first opens a Request for approval and waits for the user to
 *   allow it; see `playScript`.
 * - `end` ends the turn in `state`. It must be the last step. A script
 *   without one leaves the turn running.
 */
export type ScriptStep =
  | { readonly kind: "message"; readonly text: string; readonly deltaMs?: number }
  | { readonly kind: "stream"; readonly forMs: number; readonly deltaMs?: number }
  | {
      readonly kind: "command";
      readonly command: string;
      readonly forMs?: number;
      readonly ask?: boolean;
    }
  | {
      readonly kind: "file_change";
      readonly path: string;
      readonly forMs?: number;
      readonly ask?: boolean;
    }
  | { readonly kind: "end"; readonly state: TurnState };

/** A tool call a script step makes, in the shape Claude Code reports it. */
interface ToolCall {
  readonly kind: ItemKind;
  /** The `item.started` detail: the tool's name and input. */
  readonly detail: { readonly name: string; readonly input: Schema.JsonObject };
  /** The Request that asks the user to approve the call, without its ids. */
  readonly approval: DistributiveOmit<OpenRequest, "requestId" | "itemId">;
}

/** `Omit` applied to each member of a union, so each member keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

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
  /** The turn that is running, if any. */
  turnId: string | undefined;
  /** The Request the session is parked on, if any. */
  requestId: string | undefined;
  /** Stops the script playing into the running turn, if any. */
  script: AbortController | undefined;
  /** Resumes the script that opened the open Request, with the decision that resolved it. */
  resumeScript: ((decision: ApprovalDecision) => void) | undefined;
}

/** A scripted runner, joined to a controller and connected to it. */
export interface ScriptedRunner {
  readonly runnerId: string;
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
   * Plays a script into the session's running turn: each step reports its
   * events in order, over the time the step takes. Waits up to 5 s for a turn
   * to be running, as the one a spawn's prompt opens, and fails if none starts.
   *
   * A step with `ask` parks the script on its Request until the user allows
   * the call, with `allow` or `allow_always`; the tool call then runs, and
   * the script goes on.
   *
   * Resolves once the last step has been played, or as soon as the turn ends
   * some other way: an interrupt, `completeTurn`, or the session's exit. It
   * also resolves when the runner closes its connection itself, with
   * `goOffline`. An interrupt leaves a message that was streaming unfinished,
   * as Claude Code does. Fails if the session is already playing a script, if
   * an `end` step is not the last step, if the user denies or cancels a tool
   * call, or if the controller closes the connection before the script is
   * done.
   */
  readonly playScript: (sessionId: string, script: ReadonlyArray<ScriptStep>) => Promise<void>;
  /**
   * Ends the session for the given reason, first withdrawing the open Request
   * if there is one. The runner no longer holds the session.
   */
  readonly endSession: (sessionId: string, reason: ExitReason) => void;
  /**
   * Shuts down the way a runner does when it is stopped: it says goodbye and
   * closes its connection, so the controller shows the runner `offline`.
   * Every script playing on this runner stops first.
   */
  readonly goOffline: () => Promise<void>;
  /**
   * Connects again with the same credential and reports the sessions it
   * still holds. Fails if the runner holds more sessions than one report may
   * list.
   */
  readonly reconnect: () => Promise<void>;
}

/**
 * Joins the controller at `url` with a join token, connects, and reports that
 * it holds no sessions yet. Returns the runner once the controller has
 * answered its hello, so the runner is already online. Fails if the join is
 * refused or the controller does not answer the hello within 5 s.
 *
 * `identityPort` is the port the runner reports for its identity endpoint.
 * The scripted runner serves nothing there. A test that wants a client to
 * find this runner on its own machine serves `/identity` on that port
 * itself. There is no default, because the natural one, the first identity
 * port, is where the developer's own runner listens: a client would find
 * that runner instead.
 */
export async function enlistScriptedRunner(
  url: string,
  joinToken: string,
  identityPort: number,
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
  let socket: WebSocket;
  /** The code and reason of the last close, so a send on a closed connection can say why. */
  let lastClose: string | undefined;

  const send = (frame: RunnerToController): void => {
    if (socket.readyState !== WebSocket.OPEN) {
      const why = lastClose === undefined ? "it is closing" : `it closed with ${lastClose}`;
      throw new Error(`runner ${runnerId} is not connected; ${why}`);
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

  /**
   * Reports the user's message as an item of the running turn, as the Claude
   * Code adapter does for every input it delivers. A message steered into a
   * turn that was already running is marked `steered`.
   */
  const reportUserMessage = (sessionId: string, text: string, steered: boolean): void => {
    const session = findSession(sessionId);
    const turnId = session.turnId;
    if (turnId === undefined) throw new Error(`session ${sessionId} has no running turn`);
    const item = {
      turnId,
      itemId: randomUUID(),
      kind: "user_message",
      detail: { text, ...(steered ? { steered: true } : {}) },
    } as const;
    reportEvent(session, { _tag: "item.started", ...stampEvent(sessionId), ...item });
    reportEvent(session, {
      _tag: "item.completed",
      ...stampEvent(sessionId),
      ...item,
      status: "completed",
    });
  };

  /**
   * Stops the script playing into the session's turn, if any. The script's
   * waits fail at once, so it reports nothing more.
   */
  const stopScript = (session: HostedSession): void => {
    session.script?.abort();
    session.script = undefined;
    session.resumeScript = undefined;
  };

  /**
   * Ends the running turn in the given state, and stops the script playing
   * into it. Fails if no turn is running.
   */
  const completeTurn = (sessionId: string, state: TurnState): void => {
    const session = findSession(sessionId);
    if (session.turnId === undefined) {
      throw new Error(`session ${sessionId} has no running turn to complete`);
    }
    const turnId = session.turnId;
    session.turnId = undefined;
    stopScript(session);
    reportEvent(session, {
      _tag: "turn.completed",
      ...stampEvent(sessionId),
      turnId,
      state,
    });
  };

  /**
   * Reports that the open Request is resolved, and resumes the script parked
   * on it with the decision.
   */
  const reportRequestResolved = (
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
  ): void => {
    const session = findSession(sessionId);
    const resumeScript = session.resumeScript;
    session.requestId = undefined;
    session.resumeScript = undefined;
    reportEvent(session, {
      _tag: "request.resolved",
      ...stampEvent(sessionId),
      requestId,
      decision,
    });
    resumeScript?.(decision);
  };

  /**
   * Resolves the open Request as `cancel`, if there is one, as Claude Code
   * does before a turn is interrupted or the session exits: a Request left
   * open after that would ask about work that is no longer happening. The
   * caller stops the script first: a script resumed with `cancel` fails.
   */
  const withdrawRequest = (sessionId: string): void => {
    const requestId = findSession(sessionId).requestId;
    if (requestId !== undefined) reportRequestResolved(sessionId, requestId, "cancel");
  };

  const endSession = (sessionId: string, reason: ExitReason): void => {
    const session = findSession(sessionId);
    stopScript(session);
    withdrawRequest(sessionId);
    reportEvent(session, { _tag: "session.exited", ...stampEvent(sessionId), reason });
    sessions.delete(sessionId);
  };

  /**
   * Waits up to 5 s for the session to be held with a turn running, and
   * returns the session and the turn's id. Fails if no turn starts in that
   * time.
   */
  const waitForRunningTurn = (
    sessionId: string,
  ): Promise<{ readonly session: HostedSession; readonly turnId: string }> =>
    pollUntil(
      () => {
        const session = sessions.get(sessionId);
        return session?.turnId === undefined ? undefined : { session, turnId: session.turnId };
      },
      {
        timeoutMs: 5_000,
        intervalMs: 10,
        timeoutMessage: `session ${sessionId} has no running turn on runner ${runnerId}`,
      },
    );

  /**
   * Reports one assistant message the way Claude Code streams it:
   * `item.started`, one `content.delta` per piece of text, `delayMs` apart,
   * and `item.completed`. The item id has the shape Claude Code gives a
   * streamed block: the API message's id and the block's index.
   */
  const streamMessage = async (
    sessionId: string,
    turnId: string,
    pieces: Iterable<string>,
    delayMs: number,
    signal: AbortSignal,
  ): Promise<void> => {
    const session = findSession(sessionId);
    const itemId = `msg_${randomBytes(12).toString("hex")}#0`;
    const kind = "assistant_message";
    reportEvent(session, { _tag: "item.started", ...stampEvent(sessionId), turnId, itemId, kind });
    for (const delta of pieces) {
      await sleep(delayMs, undefined, { signal });
      reportEvent(session, {
        _tag: "content.delta",
        ...stampEvent(sessionId),
        turnId,
        itemId,
        streamKind: "assistant_text",
        delta,
      });
    }
    reportEvent(session, {
      _tag: "item.completed",
      ...stampEvent(sessionId),
      turnId,
      itemId,
      kind,
      status: "completed",
    });
  };

  /**
   * Reports one tool call the way Claude Code does. With `ask`, the call first
   * opens its Request and waits for the user to allow it. Fails if the user
   * denies or cancels the call: no script plays that answer, so a test that
   * gives it has gone wrong.
   */
  const runToolCall = async (
    sessionId: string,
    turnId: string,
    call: ToolCall,
    options: { readonly forMs?: number; readonly ask?: boolean },
    signal: AbortSignal,
  ): Promise<void> => {
    const session = findSession(sessionId);
    const itemId = `toolu_${randomBytes(12).toString("hex")}`;
    reportEvent(session, {
      _tag: "item.started",
      ...stampEvent(sessionId),
      turnId,
      itemId,
      kind: call.kind,
      detail: call.detail,
    });
    if (options.ask === true) {
      const request: OpenRequest = { ...call.approval, requestId: randomUUID(), itemId };
      const answered = new Promise<ApprovalDecision>((resolve, reject) => {
        session.resumeScript = resolve;
        signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
      });
      session.requestId = request.requestId;
      reportEvent(session, { _tag: "request.opened", ...stampEvent(sessionId), request });
      const decision = await answered;
      if (decision !== "allow" && decision !== "allow_always") {
        throw new Error(
          `the user answered the Request of session ${sessionId} with ${decision}; ` +
            "a scripted tool call plays only a call the user allows",
        );
      }
    }
    await sleep(options.forMs ?? 0, undefined, { signal });
    reportEvent(session, {
      _tag: "item.completed",
      ...stampEvent(sessionId),
      turnId,
      itemId,
      kind: call.kind,
      status: "completed",
      detail: { content: TOOL_OUTPUT },
    });
  };

  /** Plays one step of a script into the given turn, which is running. */
  const playStep = async (
    sessionId: string,
    turnId: string,
    step: ScriptStep,
    signal: AbortSignal,
  ): Promise<void> => {
    switch (step.kind) {
      case "message":
        return streamMessage(
          sessionId,
          turnId,
          splitIntoWords(step.text),
          step.deltaMs ?? WORD_DELAY_MS,
          signal,
        );
      case "stream":
        return streamMessage(
          sessionId,
          turnId,
          generateMarkdownWords(Date.now() + step.forMs),
          step.deltaMs ?? STREAM_DELAY_MS,
          signal,
        );
      case "command":
      case "file_change":
        return runToolCall(sessionId, turnId, buildToolCall(step), step, signal);
      case "end":
        return completeTurn(sessionId, step.state);
    }
  };

  const playScript = async (sessionId: string, script: ReadonlyArray<ScriptStep>) => {
    const end = script.findIndex((step) => step.kind === "end");
    if (end !== -1 && end !== script.length - 1) {
      throw new Error(`the end step is step ${end + 1} of ${script.length}; it must be the last`);
    }
    const { session, turnId } = await waitForRunningTurn(sessionId);
    if (session.script !== undefined) {
      throw new Error(`session ${sessionId} is already playing a script`);
    }
    const controller = new AbortController();
    session.script = controller;
    try {
      for (const step of script) {
        if (controller.signal.aborted) return;
        await playStep(sessionId, turnId, step, controller.signal);
      }
    } catch (error) {
      // A stopped script fails its wait; that is how it learns the turn ended.
      if (!controller.signal.aborted) throw error;
    } finally {
      if (session.script === controller) session.script = undefined;
    }
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
      case "sessionStart": {
        const session: HostedSession = {
          instanceId: frame.spec.instanceId,
          seq: 0,
          turnId: undefined,
          requestId: undefined,
          script: undefined,
          resumeScript: undefined,
        };
        // A resume starts the same session id again, as a new process.
        sessions.set(frame.sessionId, session);
        return reportEvent(session, {
          _tag: "session.started",
          ...stampEvent(frame.sessionId),
          providerRefs: { nativeSessionId: buildNativeSessionId(frame.sessionId) },
        });
      }
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
        const running = session.turnId !== undefined;
        send({
          _tag: "sessionInputResult",
          requestId: frame.requestId,
          ok: true,
          delivery: running ? "steered" : "opened",
        });
        if (!running) startTurn(frame.sessionId);
        return reportUserMessage(frame.sessionId, frame.input.text, running);
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
        stopScript(session);
        withdrawRequest(frame.sessionId);
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
            // Plain Node cannot load the protocol package, so the version is
            // written out; `satisfies` fails the typecheck when it changes.
            protocolVersion: 1 satisfies typeof PROTOCOL_VERSION,
            capabilities: [],
            binaryVersion: "0.1.0",
            nonce: randomBytes(16).toString("base64"),
            facts: { ...FACTS, identityPort },
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
        // The close of an earlier connection says nothing about this one.
        lastClose = undefined;
        resolve();
      };
      opened.onclose = (event) => {
        clearTimeout(timer);
        lastClose = `${event.code} ${event.reason}`;
        if (!greeted) reject(new Error(`the controller closed the connection: ${lastClose}`));
      };
    });

  /**
   * Stops every script, then closes the connection and waits until it is
   * closed, so the controller has seen it go.
   *
   * The scripts stop first because this runner leaves on purpose. A script
   * left playing would fail on its next send, and often nothing waits for it
   * any more: a test that ends while a turn still streams disconnects its
   * runners, and the failure would be reported as an unhandled rejection.
   */
  const closeSocket = async (): Promise<void> => {
    for (const session of sessions.values()) stopScript(session);
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((resolve) => socket.addEventListener("close", resolve));
    socket.close();
    await closed;
  };

  await dial();
  send({ _tag: "sessionsReport", sessions: [] });

  return {
    runnerId,
    startTurn,
    completeTurn: (sessionId) => completeTurn(sessionId, "completed"),
    openRequest: (sessionId, kind) => {
      const session = findSession(sessionId);
      const request = buildOpenRequest(kind);
      session.requestId = request.requestId;
      reportEvent(session, { _tag: "request.opened", ...stampEvent(sessionId), request });
      return request.requestId;
    },
    playScript,
    endSession,
    goOffline: async () => {
      if (socket.readyState === WebSocket.OPEN) send({ _tag: "goodbye" });
      await closeSocket();
    },
    reconnect: async () => {
      const bindings: Array<SessionBinding> = [...sessions].map(([sessionId, session]) => ({
        sessionId,
        nativeSessionId: buildNativeSessionId(sessionId),
        instanceId: session.instanceId,
      }));
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

/**
 * Returns the provider-native id a session reports when it starts, which
 * makes the session resumable, as it is with a real harness.
 */
function buildNativeSessionId(sessionId: string): string {
  return `native-${sessionId}`;
}

/**
 * Builds the tool call a script step makes: the item Claude Code reports for
 * the tool the step names, and the Request that asks to approve it. Claude
 * Code files `Bash` as a command and `Edit` as a file change.
 */
function buildToolCall(
  step: Extract<ScriptStep, { readonly kind: "command" | "file_change" }>,
): ToolCall {
  switch (step.kind) {
    case "command":
      return {
        kind: "command_execution",
        detail: { name: "Bash", input: { command: step.command } },
        approval: {
          kind: "command_approval",
          decisions: APPROVAL_DECISIONS,
          detail: { command: step.command },
        },
      };
    case "file_change":
      return {
        kind: "file_change",
        detail: { name: "Edit", input: { file_path: step.path } },
        approval: {
          kind: "file_change_approval",
          decisions: APPROVAL_DECISIONS,
          detail: { paths: [step.path] },
        },
      };
  }
}

/**
 * Splits text into words, each with the whitespace that follows it, so the
 * words joined again are exactly the text. A message streams one word per
 * delta.
 */
function splitIntoWords(text: string): ReadonlyArray<string> {
  return text.split(/(?<=\s)(?=\S)/);
}

/**
 * Generates the words of a long Markdown message: the stream blocks, over and
 * over, until the first block boundary at or after `until`, a time in
 * milliseconds since the epoch. It always generates at least one block.
 */
function* generateMarkdownWords(until: number): Generator<string> {
  for (let index = 0; index === 0 || Date.now() < until; index += 1) {
    yield* splitIntoWords(STREAM_BLOCKS[index % STREAM_BLOCKS.length]!);
  }
}
