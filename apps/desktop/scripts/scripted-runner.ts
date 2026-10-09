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
 * - a session start with `session.started`, and then the input the start
 *   carries as it answers any other input;
 * - an input by starting a turn and reporting the user's message in it, or,
 *   while a turn runs, by reporting the message as steered into that turn.
 *   A turn runs until the caller or a script ends it, so a spawned thread
 *   settles busy;
 * - a stop with `session.exited` for the reason `stopped`;
 * - an interrupt by withdrawing the open Requests and ending the running
 *   turns as `interrupted`: every agent's, or, when the interrupt names a
 *   subagent, that subagent's and those of the subagents it started;
 * - a decision on an open approval, or answers to an open question, with
 *   `request.resolved`.
 *
 * Any agent can ask: the session's own agent, or a subagent at any depth. A
 * Request a subagent opens carries its `subagentId`.
 *
 * Nothing else happens until the caller calls a method. The simple methods
 * each report one change: a turn starts, a Request opens, the session exits.
 * `playScript` reports a whole turn's work instead: messages that stream word
 * by word, tool calls that may ask for approval and wait for the user to
 * allow them, Token Usage, and subagents that play steps of their own. It
 * reports the same events, with the same details, that the Claude Code
 * adapter in `apps/runner/src/providers` reports for that work, so a screen
 * sees what it would see from a real agent.
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
  ATTACHMENTS_CAPABILITY,
  AttachmentReference,
  ControllerToRunner,
  ExitReason,
  ItemKind,
  JoinAnswer,
  ModelOption,
  OpenRequest,
  PROTOCOL_VERSION,
  ProbeResult,
  ProviderEvent,
  RequestResolution,
  RunnerFacts,
  RunnerToController,
  SessionBinding,
  SessionInput,
  SessionStart,
  TurnState,
  Usage,
  WORKSPACE_LIFECYCLE_CAPABILITY,
  WorkspaceReport,
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
    {
      slug: "scripted",
      name: "Scripted",
      imageInput: { maxBytes: null },
      isDefault: true,
      options: MODEL_OPTIONS,
    },
    {
      slug: "scripted-large",
      name: "Scripted Large",
      imageInput: { maxBytes: null },
      options: MODEL_OPTIONS,
    },
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

/** The questions one `question` Request asks, as the protocol carries them. */
export type ScriptedQuestions = Extract<
  OpenRequest,
  { readonly kind: "question" }
>["detail"]["questions"];

/**
 * One piece of work in a scripted turn. `playScript` plays a list of steps in
 * order into the session's running turn. Each step reports the events the
 * Claude Code adapter reports for the same work:
 *
 * - `message` streams `text` as an assistant message item, one delta per
 *   word, `deltaMs` apart (20 by default). At each of its `pauses`, the
 *   stream stops until the pause's promise resolves.
 * - `stream` streams one long assistant message of generated Markdown, one
 *   delta per word, `deltaMs` apart (2 by default), for `forMs`. It stops at
 *   the first block boundary after that, so the Markdown is never cut off
 *   inside a code block.
 * - `command` and `file_change` report a tool call as Claude Code's `Bash`
 *   and `Edit`. The call runs for `forMs` (0 by default) and succeeds. With
 *   `ask`, it first opens a Request for approval and waits for the user to
 *   allow it; see `playScript`.
 * - `question` asks the user `questions` the way Claude Code's
 *   `AskUserQuestion` tool does: a `tool_call` item, and a `question` Request
 *   about it. The agent waits for the answers, and the item then completes.
 * - `usage` reports a Token Usage snapshot of the agent playing the step: the
 *   whole session's when the session's own agent plays it, the subagent's own
 *   when a subagent does.
 * - `subagent` starts the subagent `subagentId` with the brief `brief`, the
 *   way a real harness reports it (spec 06 section 13.2): the parent's
 *   `subagent` item, `subagent.started`, and then the subagent's own turn,
 *   which reports the brief as its user message, plays `steps`, and completes.
 *   Every event of that turn carries `subagentId`. The parent waits for the
 *   subagent's turn to end, unless `background` is set: then the parent's item
 *   completes at once, and the subagent goes on working, even after the
 *   parent's own turn has ended. A subagent's steps may start subagents of
 *   their own. The id must be new to the session and contain no `:`.
 * - `end` ends the turn in `state`. It must be the last step of its list. A
 *   script for the session's own agent without one leaves the turn running; a
 *   subagent's turn without one completes after its last step.
 */
export type ScriptStep =
  | {
      readonly kind: "message";
      readonly text: string;
      readonly deltaMs?: number;
      readonly pauses?: ReadonlyArray<MessagePause>;
    }
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
  | { readonly kind: "question"; readonly questions: ScriptedQuestions }
  | { readonly kind: "usage"; readonly usage: Usage }
  | {
      readonly kind: "subagent";
      readonly subagentId: string;
      /** The short task name the parent gives the subagent. */
      readonly description: string;
      /** The harness's name for the kind of agent, as Claude's `subagent_type`. */
      readonly agentType?: string;
      /** The model the subagent's turn runs on, as the harness reports it on `turn.started`. */
      readonly model?: string;
      /** The prompt the parent gives the subagent: its first turn's user message. */
      readonly brief: string;
      readonly steps: ReadonlyArray<ScriptStep>;
      readonly background?: boolean;
    }
  | { readonly kind: "end"; readonly state: TurnState };

/**
 * A point inside a scripted message where its stream stops until `until`
 * resolves. A test uses it to keep a message streaming across a step of its
 * own, however long that step takes on a loaded machine.
 */
export interface MessagePause {
  /** How many of the message's words stream before the pause. */
  readonly afterWords: number;
  /** Resolves when the message may go on. */
  readonly until: Promise<void>;
}

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

/** One agent of a hosted session: the session's own agent, or one of its subagents. */
interface Agent {
  /** The subagent's id, or `undefined` for the session's own agent. */
  readonly subagentId: string | undefined;
  /** The subagent that started this one, or `undefined` when the session's own agent did. */
  readonly parentSubagentId: string | undefined;
  /** The agent's turn that is running, if any. */
  turnId: string | undefined;
  /** How the agent's last turn ended. A parent waiting on a subagent reads it. */
  lastTurnState: TurnState | undefined;
  /** Stops the script playing into the agent's running turn, if any. */
  script: AbortController | undefined;
}

/** A Request an agent of a session is parked on. */
interface ParkedRequest {
  readonly agent: Agent;
  /** Resumes the script that opened the Request, with the decision or answers that resolved it. */
  readonly resumeScript: ((response: RequestResolution) => void) | undefined;
}

/** A session the runner holds: its start has arrived and it has not exited. */
interface HostedSession {
  readonly sessionId: string;
  readonly instanceId: string;
  /** The sequence number of the last event sent. A new process numbers from 1 again. */
  seq: number;
  readonly main: Agent;
  /** The session's subagents, by id, in the order they started. */
  readonly subagents: Map<string, Agent>;
  /** The open Requests of every agent, by request id, oldest first. */
  readonly requests: Map<string, ParkedRequest>;
}

/** A scripted runner, joined to a controller and connected to it. */
export interface ScriptedRunner {
  readonly runnerId: string;
  /** Starts a turn of the session's own agent, which makes the session busy. Fails if one is already running. */
  readonly startTurn: (sessionId: string) => void;
  /**
   * Completes the running turn of the session's own agent, which makes the
   * session idle. Fails if no such turn is running. A subagent working in the
   * background goes on.
   */
  readonly completeTurn: (sessionId: string) => void;
  /**
   * Opens a Request of the given kind for the session's own agent and returns
   * its id. A harness asks during a turn, so the session is realistic only
   * when it is busy.
   */
  readonly openRequest: (sessionId: string, kind: RequestKind) => string;
  /**
   * Plays a script into the running turn of the session's own agent: each
   * step reports its events in order, over the time the step takes. Waits up
   * to 5 s for a turn to be running, as the one a spawn's prompt opens, and
   * fails if none starts.
   *
   * A step with `ask` parks its agent on its Request until the user allows
   * the call, with `allow` or `allow_always`; the tool call then runs, and
   * the agent's script goes on. Requests of different agents can be open at
   * once, and the user may answer them in any order.
   *
   * Resolves once every step has been played, including the steps of every
   * subagent the script started in the background, or as soon as the turn
   * ends some other way: an interrupt, `completeTurn`, or the session's exit.
   * It also resolves when the runner closes its connection itself, with
   * `goOffline`. An interrupt leaves a message that was streaming unfinished,
   * as Claude Code does. Fails if the session is already playing a script, if
   * an `end` step is not the last of its list, if a subagent id is reused or
   * contains `:`, if the user denies or cancels a tool call, or if the
   * controller closes the connection before the script is done.
   */
  readonly playScript: (sessionId: string, script: ReadonlyArray<ScriptStep>) => Promise<void>;
  /**
   * Ends the session for the given reason, first withdrawing every open
   * Request. The runner no longer holds the session. A subagent turn still
   * open is left as it is: the controller reads it as cut off, and no event
   * is made up for it (spec 06 section 13.2).
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
  const workspaces = new Map<string, WorkspaceReport>();
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

  /**
   * Opens a turn of the agent and reports it, with the model it runs on when
   * one is given. Fails if the agent already has a turn running.
   */
  const openTurn = (session: HostedSession, agent: Agent, model?: string): void => {
    if (agent.turnId !== undefined) {
      throw new Error(
        `${describeAgent(agent)} of session ${session.sessionId} is already running turn ${agent.turnId}`,
      );
    }
    agent.turnId = randomUUID();
    reportEvent(session, {
      _tag: "turn.started",
      ...stampAgentEvent(session.sessionId, agent),
      turnId: agent.turnId,
      ...(model === undefined ? {} : { model }),
    });
  };

  /**
   * Reports a user message as an item of the agent's running turn, as the
   * Claude Code adapter does for every input it delivers and for the brief a
   * subagent starts with. A message steered into a turn that was already
   * running is marked `steered`. The input's images are listed in
   * `detail.attachments` without their checksum, as a real runner lists
   * them; the scripted runner never fetches their bytes.
   */
  const reportUserMessage = (
    session: HostedSession,
    agent: Agent,
    text: string,
    steered: boolean,
    attachments: ReadonlyArray<AttachmentReference> = [],
  ): void => {
    const turnId = agent.turnId;
    if (turnId === undefined) {
      throw new Error(
        `${describeAgent(agent)} of session ${session.sessionId} has no running turn`,
      );
    }
    const item = {
      turnId,
      itemId: randomUUID(),
      kind: "user_message",
      detail: {
        text,
        ...(steered ? { steered: true } : {}),
        ...(attachments.length === 0
          ? {}
          : {
              attachments: attachments.map(({ id, name, mimeType, sizeBytes }) => ({
                id,
                name,
                mimeType,
                sizeBytes,
              })),
            }),
      },
    } as const;
    const stamp = () => stampAgentEvent(session.sessionId, agent);
    reportEvent(session, { _tag: "item.started", ...stamp(), ...item });
    reportEvent(session, { _tag: "item.completed", ...stamp(), ...item, status: "completed" });
  };

  /**
   * Reports that an open Request is resolved, and resumes the script parked
   * on it with the decision or the answers. Does nothing for a Request that
   * is not open.
   */
  const resolveRequest = (
    session: HostedSession,
    requestId: string,
    response: RequestResolution,
  ): void => {
    const parked = session.requests.get(requestId);
    if (parked === undefined) return;
    session.requests.delete(requestId);
    reportEvent(session, {
      _tag: "request.resolved",
      ...stampAgentEvent(session.sessionId, parked.agent),
      requestId,
      ...response,
    });
    parked.resumeScript?.(response);
  };

  /**
   * Resolves every open Request of the agent as `cancel`, as Claude Code does
   * before the agent's turn ends or the session exits: a Request left open
   * after that would ask about work that is no longer happening. The caller
   * stops the agent's script first: a script resumed with `cancel` fails.
   */
  const withdrawRequests = (session: HostedSession, agent: Agent): void => {
    for (const [requestId, parked] of session.requests) {
      if (parked.agent === agent) resolveRequest(session, requestId, { decision: "cancel" });
    }
  };

  /**
   * Ends the agent's running turn in the given state, after stopping the
   * script playing into it and withdrawing its open Requests. Fails if the
   * agent has no turn running.
   */
  const completeTurn = (session: HostedSession, agent: Agent, state: TurnState): void => {
    const turnId = agent.turnId;
    if (turnId === undefined) {
      throw new Error(
        `${describeAgent(agent)} of session ${session.sessionId} has no running turn to complete`,
      );
    }
    stopScript(agent);
    withdrawRequests(session, agent);
    agent.turnId = undefined;
    agent.lastTurnState = state;
    reportEvent(session, {
      _tag: "turn.completed",
      ...stampAgentEvent(session.sessionId, agent),
      turnId,
      state,
    });
  };

  /**
   * Stops each agent the way an interrupt does: its script stops, its open
   * Requests resolve as `cancel`, and its running turn completes as
   * `interrupted`. An agent with no turn running reports nothing.
   */
  const interruptAgents = (session: HostedSession, agents: ReadonlyArray<Agent>): void => {
    // An agent with no turn running plays no script and is parked on no Request.
    for (const agent of agents) {
      if (agent.turnId !== undefined) completeTurn(session, agent, "interrupted");
    }
  };

  const endSession = (sessionId: string, reason: ExitReason): void => {
    const session = findSession(sessionId);
    for (const agent of listAgents(session)) stopScript(agent);
    for (const agent of listAgents(session)) withdrawRequests(session, agent);
    reportEvent(session, { _tag: "session.exited", ...stampEvent(sessionId), reason });
    sessions.delete(sessionId);
  };

  /**
   * Waits up to 5 s for the session to be held with a turn of its own agent
   * running, and returns the session. Fails if no turn starts in that time.
   */
  const waitForRunningTurn = (sessionId: string): Promise<HostedSession> =>
    pollUntil(
      () => {
        const session = sessions.get(sessionId);
        return session?.main.turnId === undefined ? undefined : session;
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
   * streamed block: the API message's id and the block's index. At each of
   * `pauses`, the stream waits for the pause's promise. Fails when the
   * agent's script is stopped during a wait.
   */
  const streamMessage = async (
    session: HostedSession,
    agent: Agent,
    turnId: string,
    pieces: Iterable<string>,
    delayMs: number,
    signal: AbortSignal,
    pauses: ReadonlyArray<MessagePause> = [],
  ): Promise<void> => {
    const itemId = `msg_${randomBytes(12).toString("hex")}#0`;
    const kind = "assistant_message";
    const stamp = () => stampAgentEvent(session.sessionId, agent);
    reportEvent(session, { _tag: "item.started", ...stamp(), turnId, itemId, kind });
    let streamed = 0;
    for (const delta of pieces) {
      for (const pause of pauses) {
        if (pause.afterWords === streamed) await waitForPause(pause.until, signal);
      }
      streamed += 1;
      await sleep(delayMs, undefined, { signal });
      reportEvent(session, {
        _tag: "content.delta",
        ...stamp(),
        turnId,
        itemId,
        streamKind: "assistant_text",
        delta,
      });
    }
    reportEvent(session, {
      _tag: "item.completed",
      ...stamp(),
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
    session: HostedSession,
    agent: Agent,
    turnId: string,
    call: ToolCall,
    options: { readonly forMs?: number; readonly ask?: boolean },
    signal: AbortSignal,
  ): Promise<void> => {
    const itemId = `toolu_${randomBytes(12).toString("hex")}`;
    const stamp = () => stampAgentEvent(session.sessionId, agent);
    reportEvent(session, {
      _tag: "item.started",
      ...stamp(),
      turnId,
      itemId,
      kind: call.kind,
      detail: call.detail,
    });
    if (options.ask === true) {
      const request: OpenRequest = { ...call.approval, requestId: randomUUID(), itemId };
      const response = await parkOnRequest(session, agent, request, signal);
      if (
        !("decision" in response) ||
        (response.decision !== "allow" && response.decision !== "allow_always")
      ) {
        throw new Error(
          `the user answered the Request of session ${session.sessionId} with ${JSON.stringify(response)}; ` +
            "a scripted tool call plays only a call the user allows",
        );
      }
    }
    await sleep(options.forMs ?? 0, undefined, { signal });
    reportEvent(session, {
      _tag: "item.completed",
      ...stamp(),
      turnId,
      itemId,
      kind: call.kind,
      status: "completed",
      detail: { content: TOOL_OUTPUT },
    });
  };

  /**
   * Opens the Request for the agent and waits until it is resolved. Returns
   * the decision or the answers it was resolved with. Fails when the agent's
   * script is stopped first, as an interrupt does before it withdraws the
   * Request.
   */
  const parkOnRequest = (
    session: HostedSession,
    agent: Agent,
    request: OpenRequest,
    signal: AbortSignal,
  ): Promise<RequestResolution> => {
    const answered = new Promise<RequestResolution>((resolve, reject) => {
      session.requests.set(request.requestId, { agent, resumeScript: resolve });
      signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
    });
    reportEvent(session, {
      _tag: "request.opened",
      ...stampAgentEvent(session.sessionId, agent),
      request,
    });
    return answered;
  };

  /**
   * Asks the user questions the way Claude Code's `AskUserQuestion` tool does:
   * the tool call's item starts, its `question` Request opens, and once the
   * user answers, the item completes with the answers as its output. Fails if
   * the Request is resolved with a decision rather than answers: only an
   * interrupt does that, and it stops the script first.
   */
  const askQuestions = async (
    session: HostedSession,
    agent: Agent,
    turnId: string,
    questions: ScriptedQuestions,
    signal: AbortSignal,
  ): Promise<void> => {
    const itemId = `toolu_${randomBytes(12).toString("hex")}`;
    const item = { turnId, itemId, kind: "tool_call" } as const;
    const stamp = () => stampAgentEvent(session.sessionId, agent);
    reportEvent(session, {
      _tag: "item.started",
      ...stamp(),
      ...item,
      detail: { name: "AskUserQuestion", input: { questions }, kind: "native" },
    });
    const response = await parkOnRequest(
      session,
      agent,
      { requestId: randomUUID(), itemId, kind: "question", detail: { questions } },
      signal,
    );
    if (!("answers" in response)) {
      throw new Error(
        `the question of session ${session.sessionId} was resolved with ${JSON.stringify(response)}; ` +
          "a scripted question goes on only once the user answers it",
      );
    }
    reportEvent(session, {
      _tag: "item.completed",
      ...stamp(),
      ...item,
      status: "completed",
      detail: { content: JSON.stringify(response.answers) },
    });
  };

  /**
   * Starts a subagent from the parent's running turn and plays its turn, in
   * the order a real harness reports it (spec 06 section 13.2). Waits for the
   * subagent's turn to end, unless the step runs it in the background: then
   * the subagent's play is added to `background`, for `playScript` to wait
   * on. Fails if the subagent's play fails, or if the parent's script is
   * stopped while it waits.
   */
  const runSubagent = async (
    session: HostedSession,
    parent: Agent,
    turnId: string,
    step: Extract<ScriptStep, { readonly kind: "subagent" }>,
    signal: AbortSignal,
    background: Array<Promise<Error | undefined>>,
  ): Promise<void> => {
    if (session.subagents.has(step.subagentId)) {
      throw new Error(`session ${session.sessionId} already has subagent ${step.subagentId}`);
    }
    const itemId = `toolu_${randomBytes(12).toString("hex")}`;
    const item = {
      turnId,
      itemId,
      kind: "subagent",
      detail: {
        name: "Agent",
        input: { description: step.description, prompt: step.brief },
        subagentIds: [step.subagentId],
      },
    } as const;
    const stamp = () => stampAgentEvent(session.sessionId, parent);
    reportEvent(session, { _tag: "item.started", ...stamp(), ...item });

    const subagent: Agent = {
      subagentId: step.subagentId,
      parentSubagentId: parent.subagentId,
      turnId: undefined,
      lastTurnState: undefined,
      script: undefined,
    };
    session.subagents.set(step.subagentId, subagent);
    // The introduction belongs to the parent, so it names the parent rather
    // than carrying an attribution of its own.
    reportEvent(session, {
      _tag: "subagent.started",
      ...stampEvent(session.sessionId),
      subagentId: step.subagentId,
      ...(parent.subagentId === undefined ? {} : { parentSubagentId: parent.subagentId }),
      itemId,
      description: step.description,
      ...(step.agentType === undefined ? {} : { agentType: step.agentType }),
    });
    openTurn(session, subagent, step.model);
    reportUserMessage(session, subagent, step.brief, false);
    const played = playSubagentTurn(session, subagent, step.steps, background);

    if (step.background === true) {
      background.push(captureFailure(played));
      reportEvent(session, { _tag: "item.completed", ...stamp(), ...item, status: "completed" });
      return;
    }
    await played;
    signal.throwIfAborted();
    reportEvent(session, {
      _tag: "item.completed",
      ...stamp(),
      ...item,
      status: subagent.lastTurnState === "completed" ? "completed" : "failed",
    });
  };

  /**
   * Plays a subagent's steps into its running turn, then completes the turn
   * if the steps left it open. A turn ended some other way, by an interrupt,
   * an `end` step or the session's exit, is left as it is.
   */
  const playSubagentTurn = async (
    session: HostedSession,
    subagent: Agent,
    steps: ReadonlyArray<ScriptStep>,
    background: Array<Promise<Error | undefined>>,
  ): Promise<void> => {
    const finished = await playSteps(session, subagent, steps, background);
    if (finished && subagent.turnId !== undefined) completeTurn(session, subagent, "completed");
  };

  /** Plays one step of a script into the given turn of the agent, which is running. */
  const playStep = async (
    session: HostedSession,
    agent: Agent,
    turnId: string,
    step: ScriptStep,
    signal: AbortSignal,
    background: Array<Promise<Error | undefined>>,
  ): Promise<void> => {
    switch (step.kind) {
      case "message":
        return streamMessage(
          session,
          agent,
          turnId,
          splitIntoWords(step.text),
          step.deltaMs ?? WORD_DELAY_MS,
          signal,
          step.pauses,
        );
      case "stream":
        return streamMessage(
          session,
          agent,
          turnId,
          generateMarkdownWords(Date.now() + step.forMs),
          step.deltaMs ?? STREAM_DELAY_MS,
          signal,
        );
      case "command":
      case "file_change":
        return runToolCall(session, agent, turnId, buildToolCall(step), step, signal);
      case "question":
        return askQuestions(session, agent, turnId, step.questions, signal);
      case "usage":
        return reportEvent(session, {
          _tag: "session.usage.updated",
          ...stampAgentEvent(session.sessionId, agent),
          usage: step.usage,
        });
      case "subagent":
        return runSubagent(session, agent, turnId, step, signal, background);
      case "end":
        return completeTurn(session, agent, step.state);
    }
  };

  /**
   * Plays steps into the agent's running turn, in order, until they run out
   * or the agent's script is stopped. Returns true when every step was
   * played and the script was not stopped. Fails if the agent is already
   * playing a script, or if a step fails while the script is not stopped.
   */
  const playSteps = async (
    session: HostedSession,
    agent: Agent,
    steps: ReadonlyArray<ScriptStep>,
    background: Array<Promise<Error | undefined>>,
  ): Promise<boolean> => {
    if (agent.script !== undefined) {
      throw new Error(
        `${describeAgent(agent)} of session ${session.sessionId} is already playing a script`,
      );
    }
    const controller = new AbortController();
    agent.script = controller;
    try {
      for (const step of steps) {
        const turnId = agent.turnId;
        if (controller.signal.aborted || turnId === undefined) return false;
        await playStep(session, agent, turnId, step, controller.signal, background);
      }
      return !controller.signal.aborted;
    } catch (error) {
      // A stopped script fails its wait; that is how it learns the turn ended.
      if (!controller.signal.aborted) throw error;
      return false;
    } finally {
      if (agent.script === controller) agent.script = undefined;
    }
  };

  const playScript = async (sessionId: string, script: ReadonlyArray<ScriptStep>) => {
    checkScript(script);
    const session = await waitForRunningTurn(sessionId);
    // A subagent in the background can outlive the turn that started it, so
    // its play is waited on after the main script, and a failure in it is
    // still reported. Each play is caught as it is added, so a failure that
    // comes before the wait is not an unhandled rejection.
    const background: Array<Promise<Error | undefined>> = [];
    const failures = [await captureFailure(playSteps(session, session.main, script, background))];
    // A background subagent may start more of them, so the list can grow while
    // it is read.
    for (let index = 0; index < background.length; index += 1) {
      failures.push(await background[index]);
    }
    const failure = failures.find((one) => one !== undefined);
    if (failure !== undefined) throw failure;
  };

  /**
   * Answers an input as delivered, then reports the user's message: in a new
   * turn when the session is idle, or as steered into the running turn. Both
   * a session input and the input a session start carries arrive here.
   */
  const deliverInput = (session: HostedSession, frame: SessionInput | SessionStart): void => {
    // Input goes to the session's own agent; a subagent takes no messages.
    const running = session.main.turnId !== undefined;
    send({
      _tag: "sessionInputResult",
      requestId: frame.requestId,
      ok: true,
      delivery: running ? "steered" : "opened",
    });
    if (!running) openTurn(session, session.main);
    reportUserMessage(session, session.main, frame.input.text, running, frame.input.attachments);
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
      case "workspaceProvision": {
        const report: WorkspaceReport = {
          _tag: "workspaceReport",
          workspaceId: frame.workspaceId,
          status: "ready",
          checkouts: frame.checkouts.map((checkout) => ({
            checkoutId: checkout.checkoutId,
            branch: checkout.branch ?? "main",
            branches: checkout.branch === null ? ["main"] : ["main", checkout.branch],
            defaultBranch: "main",
            form: "worktree",
          })),
        };
        workspaces.set(frame.workspaceId, report);
        return send(report);
      }
      case "workspaceInspect":
        return send({
          _tag: "workspaceInspection",
          requestId: frame.requestId,
          report: workspaces.get(frame.workspaceId)!,
        });
      case "workspaceDispose":
      case "workspaceDetach": {
        const report: WorkspaceReport = {
          _tag: "workspaceReport",
          workspaceId: frame.workspaceId,
          status: "deleted",
          ...(frame.requestId === undefined ? {} : { requestId: frame.requestId }),
        };
        workspaces.set(frame.workspaceId, report);
        return send(report);
      }
      case "sessionStart": {
        const session: HostedSession = {
          sessionId: frame.sessionId,
          instanceId: frame.spec.instanceId,
          seq: 0,
          main: {
            subagentId: undefined,
            parentSubagentId: undefined,
            turnId: undefined,
            lastTurnState: undefined,
            script: undefined,
          },
          subagents: new Map(),
          requests: new Map(),
        };
        // A resume starts the same session id again, as a new process.
        sessions.set(frame.sessionId, session);
        reportEvent(session, {
          _tag: "session.started",
          ...stampEvent(frame.sessionId),
          providerRefs: { nativeSessionId: buildNativeSessionId(frame.sessionId) },
        });
        return deliverInput(session, frame);
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
        return deliverInput(session, frame);
      }
      // A frame can cross a session's exit on the wire: the controller sends it
      // before it has handled the `session.exited` this runner already sent.
      // A real runner ignores a frame for a session it no longer holds.
      case "sessionStop":
        if (!sessions.has(frame.sessionId)) return;
        return endSession(frame.sessionId, "stopped");
      // A late response to a Request that is no longer open is ignored.
      case "sessionRespondToApprovalRequest": {
        const session = sessions.get(frame.sessionId);
        if (session === undefined) return;
        return resolveRequest(session, frame.requestId, { decision: frame.decision });
      }
      case "sessionRespondToQuestion": {
        const session = sessions.get(frame.sessionId);
        if (session === undefined) return;
        return resolveRequest(session, frame.requestId, { answers: frame.answers });
      }
      // Without a subagent id, an interrupt stops all work in the session, even
      // while its own agent is idle and only subagents run. With one, it stops
      // that subagent and every subagent below it (spec 06 section 13.4).
      case "sessionInterrupt": {
        const session = sessions.get(frame.sessionId);
        if (session === undefined) return;
        if (frame.subagentId === undefined) return interruptAgents(session, listAgents(session));
        const stopped = session.subagents.get(frame.subagentId);
        if (stopped === undefined) return;
        return interruptAgents(
          session,
          listAgents(session).filter(
            (agent) => agent === stopped || isBelow(session, agent, frame.subagentId!),
          ),
        );
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
            protocolVersion: 6 satisfies typeof PROTOCOL_VERSION,
            capabilities: [
              "workspaceLifecycle" satisfies typeof WORKSPACE_LIFECYCLE_CAPABILITY,
              "attachments" satisfies typeof ATTACHMENTS_CAPABILITY,
            ],
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
    for (const session of sessions.values()) {
      for (const agent of listAgents(session)) stopScript(agent);
    }
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((resolve) => socket.addEventListener("close", resolve));
    socket.close();
    await closed;
  };

  await dial();
  send({ _tag: "sessionsReport", sessions: [] });

  return {
    runnerId,
    startTurn: (sessionId) => {
      const session = findSession(sessionId);
      openTurn(session, session.main);
    },
    completeTurn: (sessionId) => {
      const session = findSession(sessionId);
      completeTurn(session, session.main, "completed");
    },
    openRequest: (sessionId, kind) => {
      const session = findSession(sessionId);
      const request = buildOpenRequest(kind);
      session.requests.set(request.requestId, { agent: session.main, resumeScript: undefined });
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

/** Returns the fields every event carries. */
function stampEvent(sessionId: string) {
  return { eventId: randomUUID(), sessionId, at: new Date().toISOString() };
}

/**
 * Returns the fields every event of an agent carries: those of `stampEvent`,
 * and the subagent's id when the agent is a subagent.
 */
function stampAgentEvent(sessionId: string, agent: Agent) {
  return {
    ...stampEvent(sessionId),
    ...(agent.subagentId === undefined ? {} : { subagentId: agent.subagentId }),
  };
}

/** Describes an agent for an error message: "the session's own agent" or "subagent <id>". */
function describeAgent(agent: Agent): string {
  return agent.subagentId === undefined
    ? "the session's own agent"
    : `subagent ${agent.subagentId}`;
}

/** Lists every agent of the session: its own agent first, then its subagents in the order they started. */
function listAgents(session: HostedSession): ReadonlyArray<Agent> {
  return [session.main, ...session.subagents.values()];
}

/** Checks whether the agent was started, directly or further down, by the subagent `ancestorId`. */
function isBelow(session: HostedSession, agent: Agent, ancestorId: string): boolean {
  for (let parent = agent.parentSubagentId; parent !== undefined;) {
    if (parent === ancestorId) return true;
    parent = session.subagents.get(parent)?.parentSubagentId;
  }
  return false;
}

/** Stops the script playing into the agent's turn, if any. The script's waits fail at once, so it reports nothing more. */
function stopScript(agent: Agent): void {
  agent.script?.abort();
  agent.script = undefined;
}

/**
 * Checks a script before it is played, and every subagent's steps in it.
 * Fails if an `end` step is not the last of its list, or if a subagent id
 * contains `:`, which the protocol refuses.
 */
function checkScript(script: ReadonlyArray<ScriptStep>): void {
  const end = script.findIndex((step) => step.kind === "end");
  if (end !== -1 && end !== script.length - 1) {
    throw new Error(`the end step is step ${end + 1} of ${script.length}; it must be the last`);
  }
  for (const step of script) {
    if (step.kind !== "subagent") continue;
    if (step.subagentId.includes(":")) {
      throw new Error(
        `the subagent id ${step.subagentId} contains ":", which the protocol refuses`,
      );
    }
    checkScript(step.steps);
  }
}

/**
 * Waits for a play to settle and returns its failure as an `Error`, or
 * `undefined` when it succeeded. It never rejects.
 */
function captureFailure(play: Promise<unknown>): Promise<Error | undefined> {
  return play.then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
}

/**
 * Builds a Request of the given kind, with the details a harness would send.
 * A question offers no decision, like the real adapters: it is answered with
 * answers, or turned down by interrupting the turn.
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
            {
              question: "Which checks should run before each commit?",
              header: "Checks",
              options: [
                { label: "Typecheck", description: "Catches type errors in seconds." },
                { label: "Lint", description: "Keeps the style consistent." },
                { label: "Tests", description: "Slower, but proves behaviour." },
              ],
              multiSelect: true,
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
 * Waits until `until` resolves. Fails with the abort's reason when `signal`
 * aborts first, as it does when the turn ends while a message is paused.
 */
function waitForPause(until: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
    until.then(resolve, reject);
  });
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
