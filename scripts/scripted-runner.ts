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
 * - a probe with a logged-in report that offers two models, each with a
 *   reasoning effort and a fast mode;
 * - a workspace provision with `ready`, and a dispose with `deleted`;
 * - a session start with `session.started`, unless starts are held;
 * - an input by starting a turn and reporting the user's message in it, or,
 *   while a turn runs, by reporting the message as steered into that turn.
 *   A turn runs until the caller or a script ends it, so a spawned thread
 *   settles busy. A session set to crash on its next input exits instead;
 * - a stop with `session.exited` for the reason `stopped`;
 * - an interrupt by withdrawing the open Request, if any, and ending the
 *   running turn as `interrupted`;
 * - a response to the open Request with `request.resolved`.
 *
 * Nothing else happens until the caller calls a method. The simple methods
 * each report one change: a turn starts, a Request opens, the session exits.
 * `playScript` reports a whole turn's work instead: reasoning, messages that
 * stream word by word, tool calls that may ask for approval and wait for the
 * user's answer. It reports the same events, with the same details, that the
 * Claude Code adapter in `apps/runner/src/providers` reports for that work, so
 * a screen sees what it would see from a real agent.
 *
 * Like `controller-process.ts`, it uses only Node's APIs, imports nothing from
 * a test framework, and uses only TypeScript that Node can strip, because the
 * perf script runs it on plain Node. It imports only types from the protocol
 * package, so the compiler checks every frame it writes against the protocol.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { Schema } from "effect";
import type {
  ApprovalDecision,
  ControllerToRunner,
  ExitReason,
  ItemKind,
  JoinAnswer,
  ModelOption,
  OpenRequest,
  ProbeResult,
  ProviderEvent,
  RunnerFacts,
  RunnerToController,
  SessionBinding,
  StreamKind,
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

/** The tool result Claude Code reports when the user denies a tool call. */
const REFUSED = "the user did not allow this";

/** The tool result Claude Code reports when the user cancels the turn from a Request. */
const CANCELLED = "the user cancelled this turn";

/** The tool result a scripted tool call reports when it succeeds. */
const TOOL_OUTPUT = "ok";

/** How long a script waits between the words of a message or reasoning, by default. */
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
 * - `reasoning` and `message` stream `text` as a reasoning or an assistant
 *   message item, one delta per word, `deltaMs` apart (20 by default).
 * - `stream` streams one long assistant message of generated Markdown, one
 *   delta per word, `deltaMs` apart (2 by default), for `forMs`. It stops at
 *   the first block boundary after that, so the Markdown is never cut off
 *   inside a code block.
 * - `command`, `file_change`, `tool` and `web_search` report a tool call as
 *   Claude Code's `Bash`, `Edit`, the named tool, and `WebSearch`. The call
 *   runs for `forMs` (0 by default) and succeeds. With `ask`, it first opens a
 *   Request for approval and waits for the user's answer; see `playScript`.
 *   `tool` is for a tool Claude Code files as a plain tool call, such as
 *   `WebFetch` or an MCP tool (`mcp__<server>__<tool>`), not for `Bash` or
 *   `Edit`, which have their own steps.
 * - `pause` waits for `forMs` without reporting anything.
 * - `end` ends the turn in `state`, with `error` when it failed. It must be the
 *   last step. A script without one leaves the turn running.
 */
export type ScriptStep =
  | { readonly kind: "reasoning"; readonly text: string; readonly deltaMs?: number }
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
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly input?: Schema.JsonObject;
      readonly forMs?: number;
      readonly ask?: boolean;
    }
  | {
      readonly kind: "web_search";
      readonly query: string;
      readonly forMs?: number;
      readonly ask?: boolean;
    }
  | { readonly kind: "pause"; readonly forMs: number }
  | { readonly kind: "end"; readonly state: TurnState; readonly error?: string };

/** A tool call a script step makes, in the shape Claude Code reports it. */
interface ToolCall {
  readonly kind: ItemKind;
  /** The `item.started` detail: the tool's name and input, and for a plain tool call whether it is an MCP tool. */
  readonly detail: {
    readonly name: string;
    readonly input: Schema.JsonObject;
    readonly kind?: "mcp" | "native";
  };
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
  /** False while the start is held, until `startSession` reports it. */
  started: boolean;
  /** The provider-native id that makes the session resumable; absent when it is not. */
  nativeSessionId: string | undefined;
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
  /**
   * Plays a script into the session's running turn: each step reports its
   * events in order, over the time the step takes. Waits up to 5 s for a turn
   * to be running, as the one a spawn's prompt opens, and fails if none starts.
   *
   * A step with `ask` parks the script on its Request until the user answers:
   *
   * - `allow` and `allow_always` run the tool call, and the script goes on;
   * - `deny` fails the tool call, and the script goes on, as the model would;
   * - `cancel` fails the tool call and ends the turn as `interrupted`.
   *
   * Resolves once the last step has been played, or as soon as the turn ends
   * some other way: a cancel, an interrupt, `completeTurn`, or the session's
   * exit. It also resolves when the runner closes its connection itself, with
   * `goOffline` or `goUnreachable`. An interrupt leaves a message that was
   * streaming unfinished, as Claude Code does. Fails if the session is already
   * playing a script, if an `end` step is not the last step, or if the
   * controller closes the connection before the script is done.
   */
  readonly playScript: (sessionId: string, script: ReadonlyArray<ScriptStep>) => Promise<void>;
  /**
   * Ends the session for the given reason, first withdrawing the open Request
   * if there is one. The runner no longer holds the session.
   */
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
   * Every script playing on this runner stops first.
   */
  readonly goOffline: () => Promise<void>;
  /**
   * Closes the connection without a goodbye, like a machine that lost its
   * network, so the controller shows the runner `unreachable`. Every script
   * playing on this runner stops first.
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
   * Ends the running turn in the given state, with an error message when it
   * failed, and stops the script playing into it. Fails if no turn is running.
   */
  const completeTurn = (sessionId: string, state: TurnState, error?: string): void => {
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
      ...(error === undefined ? {} : { error }),
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
   * open after that would ask about work that is no longer happening.
   */
  const withdrawRequest = (sessionId: string): void => {
    const requestId = findSession(sessionId).requestId;
    if (requestId !== undefined) reportRequestResolved(sessionId, requestId, "cancel");
  };

  const endSession = (sessionId: string, reason: ExitReason): void => {
    const session = findSession(sessionId);
    // Stop the script first, so the withdrawal does not resume it.
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
  const waitForRunningTurn = async (
    sessionId: string,
  ): Promise<{ readonly session: HostedSession; readonly turnId: string }> => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const session = sessions.get(sessionId);
      if (session?.turnId !== undefined) return { session, turnId: session.turnId };
      if (Date.now() > deadline) {
        throw new Error(`session ${sessionId} has no running turn on runner ${runnerId}`);
      }
      await sleep(10);
    }
  };

  /**
   * Reports one text item the way Claude Code streams it: `item.started`, one
   * `content.delta` per piece of text, `delayMs` apart, and `item.completed`.
   * The item id has the shape Claude Code gives a streamed block: the API
   * message's id and the block's index.
   */
  const streamTextItem = async (
    sessionId: string,
    turnId: string,
    kind: "assistant_message" | "reasoning",
    streamKind: StreamKind,
    pieces: Iterable<string>,
    delayMs: number,
    signal: AbortSignal,
  ): Promise<void> => {
    const session = findSession(sessionId);
    const itemId = `msg_${randomBytes(12).toString("hex")}#0`;
    reportEvent(session, { _tag: "item.started", ...stampEvent(sessionId), turnId, itemId, kind });
    for (const delta of pieces) {
      await sleep(delayMs, undefined, { signal });
      reportEvent(session, {
        _tag: "content.delta",
        ...stampEvent(sessionId),
        turnId,
        itemId,
        streamKind,
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
   * opens its Request and waits for the answer: a denied or cancelled call
   * fails with the result Claude Code gives the model, and a cancelled call
   * also ends the turn as `interrupted`.
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
    const completeItem = (status: "completed" | "failed", content: string): void =>
      reportEvent(session, {
        _tag: "item.completed",
        ...stampEvent(sessionId),
        turnId,
        itemId,
        kind: call.kind,
        status,
        detail: { content },
      });
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
      if (decision === "deny") return completeItem("failed", REFUSED);
      if (decision === "cancel") {
        completeItem("failed", CANCELLED);
        return completeTurn(sessionId, "interrupted");
      }
    }
    await sleep(options.forMs ?? 0, undefined, { signal });
    completeItem("completed", TOOL_OUTPUT);
  };

  /** Plays one step of a script into the given turn, which is running. */
  const playStep = async (
    sessionId: string,
    turnId: string,
    step: ScriptStep,
    signal: AbortSignal,
  ): Promise<void> => {
    switch (step.kind) {
      case "reasoning":
        return streamTextItem(
          sessionId,
          turnId,
          "reasoning",
          "reasoning_text",
          splitIntoWords(step.text),
          step.deltaMs ?? WORD_DELAY_MS,
          signal,
        );
      case "message":
        return streamTextItem(
          sessionId,
          turnId,
          "assistant_message",
          "assistant_text",
          splitIntoWords(step.text),
          step.deltaMs ?? WORD_DELAY_MS,
          signal,
        );
      case "stream":
        return streamTextItem(
          sessionId,
          turnId,
          "assistant_message",
          "assistant_text",
          generateMarkdownWords(Date.now() + step.forMs),
          step.deltaMs ?? STREAM_DELAY_MS,
          signal,
        );
      case "command":
      case "file_change":
      case "tool":
      case "web_search":
        return runToolCall(sessionId, turnId, buildToolCall(step), step, signal);
      case "pause":
        await sleep(step.forMs, undefined, { signal });
        return;
      case "end":
        return completeTurn(sessionId, step.state, step.error);
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
      case "sessionStart":
        // A resume starts the same session id again, as a new process.
        sessions.set(frame.sessionId, {
          instanceId: frame.spec.instanceId,
          seq: 0,
          started: false,
          nativeSessionId: undefined,
          turnId: undefined,
          requestId: undefined,
          script: undefined,
          resumeScript: undefined,
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
        // A script parked on the open Request takes the withdrawal as a
        // cancel, and ends the turn itself, after failing its tool call.
        const parked = session.resumeScript !== undefined;
        withdrawRequest(frame.sessionId);
        if (!parked) completeTurn(frame.sessionId, "interrupted");
        return;
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
    playScript,
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

/**
 * Builds the tool call a script step makes: the item Claude Code reports for
 * the tool the step names, and the Request that asks to approve it. The tools
 * are the ones Claude Code files under each item kind: `Bash` is a command,
 * `Edit` a file change, `WebSearch` a web search, and any other tool a plain
 * tool call.
 */
function buildToolCall(
  step: Extract<ScriptStep, { readonly kind: "command" | "file_change" | "tool" | "web_search" }>,
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
    case "tool":
      return {
        kind: "tool_call",
        detail: {
          name: step.name,
          input: step.input ?? {},
          kind: step.name.startsWith("mcp__") ? "mcp" : "native",
        },
        approval: {
          kind: "tool_approval",
          decisions: APPROVAL_DECISIONS,
          detail: { toolName: step.name },
        },
      };
    case "web_search":
      return {
        kind: "web_search",
        detail: { name: "WebSearch", input: { query: step.query } },
        approval: {
          kind: "tool_approval",
          decisions: APPROVAL_DECISIONS,
          detail: { toolName: "WebSearch" },
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
