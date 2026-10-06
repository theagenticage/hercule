/**
 * Converts the Claude Agent SDK's message stream into the normalized event
 * taxonomy. `normalize` takes one message and a small mutable state, and
 * returns events. It does not call the SDK or read the clock itself. Spec 06
 * section 6 owns the taxonomy.
 *
 * The state is needed because the taxonomy groups what the SDK reports as a
 * flat sequence of messages:
 *
 * - a turn spans many messages and ends at the `result` message;
 * - a text item runs from `content_block_start` to `content_block_stop`;
 * - a tool item is closed by the `tool_result` that arrives one message later;
 * - a subagent's frames name it only by the `Agent` call that started it, and
 *   its turns are the adapter's own (spec 06 section 13.6).
 *
 * Nothing throws. A message this build does not recognise becomes an `unknown`
 * item that carries the raw payload (spec 06 section 6.7).
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  MAX_MESSAGE_LENGTH,
  type ContinuedSubagent,
  type ItemKind,
  type OutputSchema,
  type ProviderEvent,
  type StreamKind,
  type StructuredResult,
  type TurnState,
  type Usage,
} from "@hercule/protocol";
import {
  buildSubagentRegistry,
  cleanSubagentId,
  findSendMessageRecipient,
  findSubagentByAgentCall,
  isSubagentWorking,
  recordAgentCall,
  recordDroppedFrames,
  registerSubagent,
  takeWaitingRequests,
  type Subagent,
  type SubagentRegistry,
} from "./claude-code-subagents";
import { clampCount, toJson } from "./normalize";
import { judgeAnswer, type HarnessAnswer } from "./structured-result";
import { truncateFact } from "./text";

/** The `source` name on every raw payload from this adapter. */
export const CLAUDE_SDK_MESSAGE = "claude.sdk.message";

/** An open text or reasoning block whose deltas are still arriving. */
interface Block {
  readonly itemId: string;
  readonly kind: ItemKind;
  readonly streamKind: StreamKind;
}

/**
 * What one agent is streaming: the session's own agent or one subagent. Each
 * agent numbers its content blocks on its own, and one agent's turn ending
 * must not cut off another's stream.
 */
interface AgentStream {
  /**
   * The assistant message the agent is streaming right now, if any, with the
   * model `message_start` named for it.
   */
  current:
    | {
        readonly messageId: string;
        readonly model: string | undefined;
        readonly blocks: Map<number, Block>;
      }
    | undefined;
  /**
   * The ids of the agent's assistant messages whose blocks arrived as stream
   * events. With `includePartialMessages`, the complete message that follows
   * repeats what was already streamed, so only a message that never streamed
   * still needs its text reported. Messages are matched by id, not by block
   * index, because a block's position in the message is not its position in
   * the stream.
   */
  readonly streamed: Set<string>;
}

/** The state `normalize` keeps for one session between messages. */
export interface Normalizing {
  readonly sessionId: string;
  /** Creates a new id: for events, and for turns and items the SDK gives no id. */
  readonly mint: () => string;
  /** The runner's own clock, as an ISO-8601 instant. */
  readonly now: () => string;
  /** The schema every turn's output must match. `undefined` means free text. */
  readonly outputSchema: OutputSchema | undefined;
  /**
   * The open turn of the session's own agent, or `undefined` between turns.
   * The adapter opens the first. Subagents' turns are in `subagents`.
   */
  turnId: string | undefined;
  /** What each agent is streaming, keyed by `buildStreamKey`. */
  readonly streams: Map<string, AgentStream>;
  /**
   * The kind of each open tool item, by `tool_use` id, so its `tool_result`
   * completes it with the same kind. Tool ids are unique across agents.
   */
  readonly tools: Map<string, ItemKind>;
  /** The session's subagents and their turns. */
  readonly subagents: SubagentRegistry;
  /**
   * Frames from a subagent the registry does not know yet, in the order they
   * arrived: from an agent call no `task_started` has linked, or a denial
   * naming an unknown agent id. Each waits for the `task_started` that links
   * it, and at most `MAX_HELD_FRAMES` of them are kept.
   */
  readonly heldFrames: Array<SDKMessage>;
}

/**
 * The most frames `Normalizing.heldFrames` keeps. A harness that never
 * reports a subagent's start would otherwise make the runner hold that
 * subagent's frames for the life of the process. The frame that would be one
 * more drops them all, itself included.
 */
const MAX_HELD_FRAMES = 1000;

/**
 * Returns the state for a new session. `seeded` lists the subagents a resumed
 * session already has records of, so a subagent the harness continues lands
 * on its record (spec 06 section 13.2).
 */
export const buildNormalizingState = (
  sessionId: string,
  mint: () => string,
  now: () => string,
  outputSchema: OutputSchema | undefined,
  seeded?: ReadonlyArray<ContinuedSubagent>,
): Normalizing => ({
  sessionId,
  mint,
  now,
  outputSchema,
  turnId: undefined,
  streams: new Map(),
  tools: new Map(),
  subagents: buildSubagentRegistry(seeded),
  heldFrames: [],
});

/**
 * Checks whether any agent of the session is working: the session's own
 * agent has an open turn, or a subagent's turn is open or about to open.
 */
export const isAnyAgentWorking = (state: Normalizing): boolean => {
  if (state.turnId !== undefined) return true;
  for (const subagent of state.subagents.byId.values()) {
    if (isSubagentWorking(subagent)) return true;
  }
  return false;
};

/**
 * The agent whose turn a frame belongs to: one of the session's subagents,
 * or `undefined` for the session's own agent.
 */
type TurnOwner = Subagent | undefined;

/** The turn an event goes into, and the subagent the event belongs to. */
interface TurnRef {
  readonly turnId: string;
  readonly subagentId: string | undefined;
}

/**
 * Builds the field that names the subagent an event belongs to. Returns an
 * empty object for an event of the session's own agent.
 */
const buildSubagentAttribution = (
  subagentId: string | undefined,
): { readonly subagentId?: string } => (subagentId === undefined ? {} : { subagentId });

/** Returns the key of an agent's entry in `Normalizing.streams`: `""` for the session's own agent. */
const buildStreamKey = (agent: TurnOwner): string => agent?.subagentId ?? "";

/** Returns what the agent is streaming, creating its empty entry the first time. */
const ensureAgentStream = (state: Normalizing, agent: TurnOwner): AgentStream => {
  const key = buildStreamKey(agent);
  const found = state.streams.get(key);
  if (found !== undefined) return found;
  const created: AgentStream = { current: undefined, streamed: new Set() };
  state.streams.set(key, created);
  return created;
};

/**
 * The item kind for each Claude tool name. Only the tool families the
 * taxonomy has an item kind for are mapped: shell commands, file changes, web
 * search, subagents and plans. Every other tool is a plain `tool_call`
 * (spec 06 section 6.3).
 */
const TOOL_KINDS: Readonly<Record<string, ItemKind>> = {
  Bash: "command_execution",
  BashOutput: "command_execution",
  KillShell: "command_execution",
  Shell: "command_execution",
  Edit: "file_change",
  Write: "file_change",
  NotebookEdit: "file_change",
  Patch: "file_change",
  WebSearch: "web_search",
  Task: "subagent",
  Agent: "subagent",
  SendMessage: "subagent",
  ExitPlanMode: "plan",
};

/**
 * Returns the item kind for a Claude tool name, or `tool_call` for a tool with
 * no specific kind. The adapter also uses it to pick the approval request kind,
 * so one table decides both and the two cannot disagree.
 */
export const classifyTool = (name: string): ItemKind => TOOL_KINDS[name] ?? "tool_call";

/** Checks whether a tool is an MCP tool. The name prefix is the only way to tell. */
const isMcp = (name: string): boolean => name.startsWith("mcp__");

/**
 * The tools that start a subagent. Recent CLIs name the tool `Agent` in
 * `tool_use` blocks, and older ones named it `Task`.
 */
const AGENT_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

/**
 * Converts an id the harness gives for an item, such as a tool call, into one
 * the protocol accepts. Returns `undefined` when the value is missing, not a
 * string, or empty. The agent call ids that link a subagent's frames go
 * through it too, so each one has the same spelling wherever it is read.
 */
const cleanItemId = (raw: unknown): string | undefined =>
  typeof raw === "string" && raw !== "" ? truncateFact(raw) : undefined;

/** Returns a tool input's string field, or `undefined` when it is missing or not a string. */
const readInputString = (input: unknown, key: string): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
};

/**
 * Informational messages from Claude that are dropped on purpose. Rate-limit
 * and auth updates belong in the capability snapshot, not in session events,
 * and progress messages hold nothing a transcript reader wants. A message type
 * that is neither in this list nor handled below still becomes an `unknown`
 * item rather than disappearing. Spec 06 section 6.7 lists what is trimmed.
 */
const TRIMMED: ReadonlySet<string> = new Set([
  // Top-level message types.
  "rate_limit_event",
  "auth_status",
  "tool_use_summary",
  "prompt_suggestion",
  "tool_progress",
  // `system` subtypes, with the `system:` prefix that `onSystem` looks them up with.
  "system:status",
  "system:session_state_changed",
  "system:thinking_tokens",
  "system:background_tasks_changed",
  "system:commands_changed",
  "system:hook_started",
  "system:hook_progress",
  "system:hook_response",
  "system:files_persisted",
  // The lifecycle of a task. None of these is model work: a task's command
  // already shows as its tool item, and when a background task finishes, the
  // model's answer to it arrives as ordinary `assistant` messages and a
  // `result`, which open and close a real turn. Kept, each one became an empty
  // synthetic turn.
  "system:task_progress",
  "system:task_updated",
]);

/** Truncates text to the longest message the protocol accepts. */
const cutToMessageLength = (value: string): string => value.slice(0, MAX_MESSAGE_LENGTH);

type Emit = Array<ProviderEvent>;

/**
 * Opens a turn if none is open. Returns the turn id and the events to emit:
 * one `turn.started`, or none when a turn was already open.
 *
 * Besides turns for user input, this also covers output the harness sends
 * outside any turn Hercule opened, because every item must belong to a turn
 * (spec 06 section 6.2).
 */
export const openTurn = (
  state: Normalizing,
): { readonly turnId: string; readonly events: ReadonlyArray<ProviderEvent> } => {
  const open = state.turnId;
  if (open !== undefined) return { turnId: open, events: [] };
  const turnId = state.mint();
  state.turnId = turnId;
  return {
    turnId,
    events: [
      {
        _tag: "turn.started",
        eventId: state.mint(),
        sessionId: state.sessionId,
        at: state.now(),
        turnId,
      },
    ],
  };
};

/**
 * Opens the agent's turn if none is open, and returns it. The events that open
 * it go to `out`.
 *
 * For a subagent the turn opens like this (spec 06 section 13.6):
 *
 * - `turn.started`, with `model` when the frame that opens it names one;
 * - the subagent's brief as a `user_message` item, when `task_started` gave
 *   one. A turn the subagent opens by itself has no brief;
 * - the events the adapter deferred until this turn opened.
 */
const ensureAgentTurn = (
  state: Normalizing,
  agent: TurnOwner,
  out: Emit,
  model?: string,
): TurnRef => {
  if (agent === undefined) {
    const { turnId, events } = openTurn(state);
    out.push(...events);
    return { turnId, subagentId: undefined };
  }
  const { subagentId } = agent;
  if (agent.turn.phase === "open") return { turnId: agent.turn.turnId, subagentId };
  const turn: TurnRef = { turnId: state.mint(), subagentId };
  out.push({
    _tag: "turn.started",
    eventId: state.mint(),
    sessionId: state.sessionId,
    at: state.now(),
    subagentId,
    turnId: turn.turnId,
    ...(model === undefined ? {} : { model: truncateFact(model) }),
  });
  if (agent.turn.phase === "pending" && agent.turn.prompt !== undefined) {
    // The same item the adapter reports for the user's own input, so the
    // brief reads like any other turn's input.
    const itemId = state.mint();
    const detail = { text: agent.turn.prompt };
    out.push(buildItemStarted(state, turn, itemId, "user_message", detail));
    out.push(buildItemCompleted(state, turn, itemId, "user_message", "completed", detail));
  }
  agent.turn = { phase: "open", turnId: turn.turnId };
  // The turn is open, so the subagent's requests have a turn to be shown in
  // again, even if frames that would have opened an earlier one were dropped.
  agent.openingFramesLost = false;
  out.push(...takeWaitingRequests(state.subagents, subagentId));
  return turn;
};

/**
 * Emits `turn.completed` and clears the agent's streaming state, and only that
 * agent's: another agent may be streaming at the same time. Open tool items
 * are kept, because an interrupted turn's `tool_result` still arrives later
 * and needs the kind its item started with.
 */
const closeTurn = (
  state: Normalizing,
  out: Emit,
  agent: TurnOwner,
  turnId: string,
  turnState: TurnState,
  extra: {
    readonly usage?: Usage;
    readonly error?: string;
    readonly structuredResult?: StructuredResult;
  } = {},
): void => {
  out.push({
    _tag: "turn.completed",
    eventId: state.mint(),
    sessionId: state.sessionId,
    at: state.now(),
    ...buildSubagentAttribution(agent?.subagentId),
    turnId,
    state: turnState,
    ...(extra.usage === undefined ? {} : { usage: extra.usage }),
    ...(extra.error === undefined ? {} : { error: extra.error }),
    ...(extra.structuredResult === undefined ? {} : { structuredResult: extra.structuredResult }),
  });
  state.streams.delete(buildStreamKey(agent));
  if (agent === undefined) state.turnId = undefined;
  else agent.turn = { phase: "idle" };
};

const buildItemStarted = (
  state: Normalizing,
  turn: TurnRef,
  itemId: string,
  kind: ItemKind,
  detail?: unknown,
): ProviderEvent => ({
  _tag: "item.started",
  eventId: state.mint(),
  sessionId: state.sessionId,
  at: state.now(),
  ...buildSubagentAttribution(turn.subagentId),
  turnId: turn.turnId,
  itemId,
  kind,
  ...(detail === undefined ? {} : { detail: toJson(detail) }),
});

const buildItemCompleted = (
  state: Normalizing,
  turn: TurnRef,
  itemId: string,
  kind: ItemKind,
  status: "completed" | "failed",
  detail?: unknown,
): ProviderEvent => ({
  _tag: "item.completed",
  eventId: state.mint(),
  sessionId: state.sessionId,
  at: state.now(),
  ...buildSubagentAttribution(turn.subagentId),
  turnId: turn.turnId,
  itemId,
  kind,
  status,
  ...(detail === undefined ? {} : { detail: toJson(detail) }),
});

const buildContentDelta = (
  state: Normalizing,
  turn: TurnRef,
  itemId: string,
  streamKind: StreamKind,
  text: string,
): ProviderEvent => ({
  _tag: "content.delta",
  eventId: state.mint(),
  sessionId: state.sessionId,
  at: state.now(),
  ...buildSubagentAttribution(turn.subagentId),
  turnId: turn.turnId,
  itemId,
  streamKind,
  delta: text,
});

/** Returns the events for a whole item at once, for a complete message that never streamed. */
const buildWholeItem = (
  state: Normalizing,
  turn: TurnRef,
  itemId: string,
  kind: ItemKind,
  streamKind: StreamKind,
  text: string,
): Emit => [
  buildItemStarted(state, turn, itemId, kind),
  buildContentDelta(state, turn, itemId, streamKind, text),
  buildItemCompleted(state, turn, itemId, kind, "completed"),
];

/**
 * Emits an `unknown` item, in the agent's turn, for a vendor message this
 * adapter does not map. `normalize` attaches the raw payload.
 */
const emitUnknownItem = (state: Normalizing, agent: TurnOwner, out: Emit): void => {
  const turn = ensureAgentTurn(state, agent, out);
  const itemId = state.mint();
  out.push(buildItemStarted(state, turn, itemId, "unknown"));
  out.push(buildItemCompleted(state, turn, itemId, "unknown", "completed"));
};

/**
 * Emits `subagent.started` for a subagent not yet introduced in this process
 * (spec 06 section 13.2). The event belongs to the subagent's parent, so it
 * has no `subagentId` field of its own. `task` adds what only `task_started`
 * reports: the parent's short name for the task, and the kind of agent. Each
 * is left out when it is missing, not a string, or empty.
 */
const introduceSubagent = (
  state: Normalizing,
  subagent: Subagent,
  out: Emit,
  task?: { readonly description: unknown; readonly agentType: unknown },
): void => {
  if (subagent.introduced) return;
  const description = readInputString(task, "description");
  const agentType = readInputString(task, "agentType");
  // Built before `introduced` is set, so a field that fails to convert leaves
  // the subagent to be introduced by its next frame.
  const started: ProviderEvent = {
    _tag: "subagent.started",
    eventId: state.mint(),
    sessionId: state.sessionId,
    at: state.now(),
    subagentId: subagent.subagentId,
    ...(subagent.parentSubagentId === undefined
      ? {}
      : { parentSubagentId: subagent.parentSubagentId }),
    ...(subagent.agentCallId === undefined ? {} : { itemId: subagent.agentCallId }),
    ...(description === undefined || description === ""
      ? {}
      : { description: cutToMessageLength(description) }),
    ...(agentType === undefined || agentType === "" ? {} : { agentType: truncateFact(agentType) }),
  };
  subagent.introduced = true;
  out.push(started);
};

type Streamed = Extract<SDKMessage, { type: "stream_event" }>["event"];

const onStreamEvent = (state: Normalizing, event: Streamed, agent: TurnOwner, out: Emit): void => {
  const stream = ensureAgentStream(state, agent);
  const open = stream.current;
  switch (event.type) {
    case "message_start": {
      stream.streamed.add(event.message.id);
      stream.current = {
        messageId: event.message.id,
        model: readInputString(event.message, "model"),
        blocks: new Map(),
      };
      return;
    }
    case "content_block_start": {
      const block = event.content_block;
      // A `tool_use` block streams only partial JSON arguments, which the
      // taxonomy has no kind for. The complete assistant message carries the
      // whole call later (spec 06 section 6.3).
      const kind: ItemKind | undefined =
        block.type === "text"
          ? "assistant_message"
          : block.type === "thinking"
            ? "reasoning"
            : undefined;
      if (kind === undefined || open === undefined) return;
      // A turn a stream opens carries the model too, from `message_start`.
      const turn = ensureAgentTurn(state, agent, out, open.model);
      const itemId = `${open.messageId}#${event.index}`;
      open.blocks.set(event.index, {
        itemId,
        kind,
        streamKind: kind === "reasoning" ? "reasoning_text" : "assistant_text",
      });
      out.push(buildItemStarted(state, turn, itemId, kind));
      return;
    }
    case "content_block_delta": {
      const block = open?.blocks.get(event.index);
      if (block === undefined) return;
      // Signature and partial-JSON deltas are not text, so they produce no event.
      const text =
        event.delta.type === "text_delta"
          ? event.delta.text
          : event.delta.type === "thinking_delta"
            ? event.delta.thinking
            : undefined;
      if (text === undefined || text === "") return;
      out.push(
        buildContentDelta(
          state,
          ensureAgentTurn(state, agent, out),
          block.itemId,
          block.streamKind,
          text,
        ),
      );
      return;
    }
    case "content_block_stop": {
      const block = open?.blocks.get(event.index);
      if (block === undefined || open === undefined) return;
      open.blocks.delete(event.index);
      out.push(
        buildItemCompleted(
          state,
          ensureAgentTurn(state, agent, out),
          block.itemId,
          block.kind,
          "completed",
        ),
      );
      return;
    }
    default:
      // `message_delta`, `message_stop` and pings hold nothing the taxonomy
      // needs; the content deltas already carried the text.
      return;
  }
};

/**
 * Returns what a `subagent` item lists in `detail.subagentIds`: for a
 * `SendMessage`, the subagent its `to` names, when that is a known subagent.
 * An `Agent` call lists none, because the subagent it starts has no id yet;
 * `subagent.started` links the two (spec 06 section 13.2).
 */
const listMessagedSubagents = (
  state: Normalizing,
  toolName: string,
  input: unknown,
): ReadonlyArray<string> => {
  if (toolName !== "SendMessage") return [];
  const to = readInputString(input, "to");
  const recipient = to === undefined ? undefined : findSendMessageRecipient(state.subagents, to);
  return recipient === undefined ? [] : [recipient];
};

const onAssistant = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { type: "assistant" }>,
  agent: TurnOwner,
  out: Emit,
): void => {
  const turn = ensureAgentTurn(state, agent, out, sdk.message.model);
  // Text and reasoning that streamed were already emitted, and this message
  // repeats them. Only a message that never streamed still needs them reported.
  const echo = ensureAgentStream(state, agent).streamed.has(sdk.message.id);
  for (const block of sdk.message.content) {
    if (block.type === "tool_use") {
      const kind = classifyTool(block.name);
      const itemId = cleanItemId(block.id) ?? state.mint();
      state.tools.set(itemId, kind);
      if (AGENT_TOOLS.has(block.name)) {
        recordAgentCall(
          state.subagents,
          itemId,
          agent?.subagentId,
          readInputString(block.input, "name"),
        );
      }
      const subagentIds = listMessagedSubagents(state, block.name, block.input);
      out.push(
        buildItemStarted(state, turn, itemId, kind, {
          name: block.name,
          input: block.input,
          ...(kind === "tool_call" ? { kind: isMcp(block.name) ? "mcp" : "native" } : {}),
          ...(subagentIds.length === 0 ? {} : { subagentIds }),
        }),
      );
      continue;
    }
    if (echo) continue;
    // An empty block, such as a thinking block whose text the harness leaves
    // out, would only add a blank entry to the transcript.
    if (block.type === "text" && block.text !== "") {
      out.push(
        ...buildWholeItem(
          state,
          turn,
          state.mint(),
          "assistant_message",
          "assistant_text",
          block.text,
        ),
      );
    } else if (block.type === "thinking" && block.thinking !== "") {
      out.push(
        ...buildWholeItem(state, turn, state.mint(), "reasoning", "reasoning_text", block.thinking),
      );
    }
  }
  if (sdk.error !== undefined) {
    const itemId = state.mint();
    out.push(buildItemStarted(state, turn, itemId, "error", { class: sdk.error }));
    out.push(buildItemCompleted(state, turn, itemId, "error", "failed", { class: sdk.error }));
  }
};

/**
 * Handles a user message from the harness. The harness repeats back the input
 * Hercule sent, but the repeated message does not show whether that input was
 * steered into a running turn, which `user_message` must report as `steered`
 * (spec 06 section 6.3). So the adapter reports user messages itself, and this
 * function ignores their text. A subagent's brief arrives as a user message
 * too, and is reported from `task_started` instead. This function only
 * handles `tool_result` blocks, each of which closes a tool item.
 */
const onUser = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { type: "user" }>,
  agent: TurnOwner,
  out: Emit,
): void => {
  const content = sdk.message.content;
  if (typeof content === "string") return;
  // A message with no tool result opens no turn: for a subagent it is the
  // brief, and its turn opens at the subagent's first answer.
  if (!content.some((block) => block.type === "tool_result")) return;
  const turn = ensureAgentTurn(state, agent, out);
  for (const block of content) {
    if (block.type === "tool_result") {
      const itemId = cleanItemId(block.tool_use_id) ?? state.mint();
      const kind = state.tools.get(itemId) ?? "tool_call";
      state.tools.delete(itemId);
      out.push(
        buildItemCompleted(
          state,
          turn,
          itemId,
          kind,
          block.is_error === true ? "failed" : "completed",
          {
            // Truncated because a `Read` of a big file returns it whole; `raw` keeps all of it.
            ...(block.content === undefined
              ? {}
              : {
                  content:
                    typeof block.content === "string"
                      ? cutToMessageLength(block.content)
                      : block.content,
                }),
          },
        ),
      );
    }
  }
};

/**
 * Returns the state a turn ended in. An abort is `interrupted`, which is
 * neither success nor failure.
 */
const readTurnState = (sdk: Extract<SDKMessage, { type: "result" }>): TurnState => {
  if (sdk.terminal_reason?.startsWith("aborted") === true) return "interrupted";
  return sdk.subtype === "success" && !sdk.is_error ? "completed" : "failed";
};

/**
 * Returns the session's usage so far, summed over every model. It reads
 * `modelUsage`, not `usage`: the SDK documents `usage` as covering only the
 * main agent loop, and only the current turn in a streaming-input session,
 * which every Hercule session is. `modelUsage` and `total_cost_usd` add up
 * across turns, which is what the usage snapshot must hold (spec 06 section
 * 6.6).
 */
const readUsage = (sdk: Extract<SDKMessage, { type: "result" }>): Usage => {
  const models = Object.values(sdk.modelUsage);
  const sumTokens = (read: (used: (typeof models)[number]) => number): number =>
    models.reduce((sum, used) => sum + clampCount(read(used)), 0);
  return {
    inputTokens: sumTokens((used) => used.inputTokens),
    outputTokens: sumTokens((used) => used.outputTokens),
    cacheReadTokens: sumTokens((used) => used.cacheReadInputTokens),
    cacheWriteTokens: sumTokens((used) => used.cacheCreationInputTokens),
    ...(Number.isFinite(sdk.total_cost_usd) && sdk.total_cost_usd >= 0
      ? { costUsd: sdk.total_cost_usd }
      : {}),
  };
};

/**
 * Returns the error message for a failed turn: the SDK's errors, else the
 * result text, else the subtype. Call it only for a failed turn: an interrupted
 * turn ends with `subtype: "success"` and the text the model had written so
 * far, which is not the reason the turn stopped.
 */
const describeFailure = (sdk: Extract<SDKMessage, { type: "result" }>): string => {
  if (sdk.subtype !== "success" && sdk.errors.length > 0)
    return cutToMessageLength(sdk.errors.join("; "));
  if (sdk.subtype === "success" && sdk.result !== "") return cutToMessageLength(sdk.result);
  return sdk.subtype;
};

/**
 * The SDK's result subtype for a turn where it re-prompted the model as many
 * times as allowed and still got no value that matches the schema.
 */
const RETRIES_EXHAUSTED = "error_max_structured_output_retries";

/**
 * Reads the structured output the harness produced for the schema. Returns
 * `undefined` when the result has nothing to do with the schema. Only two
 * results do:
 *
 * - a turn that ran to its end;
 * - a turn the harness gave up on because no output matched the schema.
 *
 * An interrupt or any other failure is about the turn itself. Checking the
 * schema for such a turn would report on an output that was never produced.
 */
const readHarnessAnswer = (
  sdk: Extract<SDKMessage, { type: "result" }>,
  turnState: TurnState,
): HarnessAnswer | undefined => {
  // Check for an interrupt first, whatever the subtype is. The user ended this
  // turn, so there is no output to check, even if the retries ran out.
  if (turnState === "interrupted") return undefined;
  if (sdk.subtype === RETRIES_EXHAUSTED) {
    return { missing: `the harness gave up on the schema: ${RETRIES_EXHAUSTED}` };
  }
  if (turnState !== "completed" || sdk.subtype !== "success") return undefined;
  return sdk.structured_output === undefined
    ? { missing: "the harness ended the turn without producing a structured output" }
    : { value: sdk.structured_output };
};

/**
 * Checks the turn's output against the session's schema. Returns `undefined`
 * when there is no schema or nothing to check.
 */
const judgeTurn = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { type: "result" }>,
  turnState: TurnState,
): StructuredResult | undefined => {
  const schema = state.outputSchema;
  if (schema === undefined) return undefined;
  const answer = readHarnessAnswer(sdk, turnState);
  return answer === undefined ? undefined : judgeAnswer(schema, answer);
};

const onResult = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { type: "result" }>,
  out: Emit,
): void => {
  const { turnId } = ensureAgentTurn(state, undefined, out);
  const usage = readUsage(sdk);
  const turnState = readTurnState(sdk);
  const structuredResult = judgeTurn(state, sdk, turnState);
  out.push({
    _tag: "session.usage.updated",
    eventId: state.mint(),
    sessionId: state.sessionId,
    at: state.now(),
    usage,
  });
  closeTurn(state, out, undefined, turnId, turnState, {
    usage,
    ...(turnState === "failed" ? { error: describeFailure(sdk) } : {}),
    ...(structuredResult === undefined ? {} : { structuredResult }),
  });
};

/**
 * Returns the turn state a subagent's `task_notification` status ends its
 * turn in. A stopped subagent was interrupted, which is neither success nor
 * failure.
 */
const convertTaskStatusToTurnState = (status: "completed" | "failed" | "stopped"): TurnState =>
  status === "stopped" ? "interrupted" : status;

/**
 * Handles `task_started` for a subagent; every other task type is trimmed.
 * The first `task_started` of a subagent in this process introduces it. Its
 * turn then waits for the subagent's first frame, so the turn's model is
 * known when it opens. A subagent whose turn is pending or open is left alone:
 * a later `task_started` is never read as a `SendMessage`, because a subagent
 * also wakes by itself when its background shell finishes (spec 06 section
 * 13.6).
 */
const onTaskStarted = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { subtype: "task_started" }>,
  out: Emit,
): void => {
  const subagentId = cleanSubagentId(sdk.task_id);
  if (sdk.task_type !== "local_agent" || subagentId === undefined) return;
  const isNew = !state.subagents.byId.has(subagentId);
  const subagent = registerSubagent(state.subagents, subagentId, cleanItemId(sdk.tool_use_id));
  introduceSubagent(state, subagent, out, {
    description: sdk.description,
    agentType: sdk.subagent_type,
  });
  // A subagent is registered once, so each changed id is reported once.
  if (isNew && subagentId !== sdk.task_id) {
    out.push({
      _tag: "runtime.warning",
      eventId: state.mint(),
      sessionId: state.sessionId,
      at: state.now(),
      subagentId,
      message: cutToMessageLength(
        `the harness named a subagent "${sdk.task_id}", which the protocol does not accept, so it is reported as "${subagentId}"`,
      ),
    });
  }
  if (subagent.turn.phase === "idle") subagent.turn = { phase: "pending", prompt: sdk.prompt };
};

/**
 * Handles `task_notification` for a subagent: it ends the subagent's turn,
 * opening it first if no frame did. The turn carries no usage: Claude's count
 * per task is not what the subagent spent (spec 06 section 13.5). A
 * notification for a subagent with no turn is ignored: it is an orphan, or a
 * `worker_restart` on a resume. One for any other task is trimmed.
 *
 * A subagent that ends `stopped` is stopped for good: Claude Code cannot
 * continue it, so a frame it still sends goes into a turn that ends at once.
 * A subagent whose stop was sent but that ends `completed` or `failed`
 * finished before `stopTask` reached it, or the harness refused the stop. Its
 * stop is wanted again, so it gets `stopTask` if it works again.
 */
const onTaskNotification = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { subtype: "task_notification" }>,
  out: Emit,
): void => {
  const subagentId = cleanSubagentId(sdk.task_id);
  const subagent = subagentId === undefined ? undefined : state.subagents.byId.get(subagentId);
  if (subagent === undefined || subagent.turn.phase === "idle") return;
  const { turnId } = ensureAgentTurn(state, subagent, out);
  closeTurn(state, out, subagent, turnId, convertTaskStatusToTurnState(sdk.status));
  if (sdk.status === "stopped") subagent.stop = "stopped";
  else if (subagent.stop === "sent") subagent.stop = "wanted";
};

const onSystem = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { type: "system" }>,
  agent: TurnOwner,
  out: Emit,
): void => {
  switch (sdk.subtype) {
    case "init":
      // The adapter emits `session.started` itself when it starts the session,
      // so `init` adds nothing.
      return;
    // `task_started` and `task_notification` are kept for a subagent, and
    // trimmed for every other task, as `TRIMMED` explains.
    case "task_started":
      onTaskStarted(state, sdk, out);
      return;
    case "task_notification":
      onTaskNotification(state, sdk, out);
      return;
    // Known limit: compaction and retries name no agent, so a subagent's are
    // reported as the session's own agent's (spec 06 section 13.6).
    case "compact_boundary": {
      const turn = ensureAgentTurn(state, undefined, out);
      const itemId = state.mint();
      const detail = {
        trigger: sdk.compact_metadata.trigger,
        preTokens: sdk.compact_metadata.pre_tokens,
        postTokens: sdk.compact_metadata.post_tokens,
      };
      out.push(buildItemStarted(state, turn, itemId, "context_compaction", detail));
      out.push(buildItemCompleted(state, turn, itemId, "context_compaction", "completed", detail));
      return;
    }
    case "api_retry":
      out.push({
        _tag: "runtime.warning",
        eventId: state.mint(),
        sessionId: state.sessionId,
        at: state.now(),
        ...(state.turnId === undefined ? {} : { turnId: state.turnId }),
        message: cutToMessageLength(
          `retrying after ${sdk.error}: attempt ${sdk.attempt} of ${sdk.max_retries}`,
        ),
      });
      return;
    default:
      // `permission_denied` lands here too, in the turn of the agent it names:
      // the taxonomy has no kind for it, and the denied call's item already
      // ends failed when its `tool_result` arrives.
      if (!TRIMMED.has(`system:${sdk.subtype}`)) emitUnknownItem(state, agent, out);
      return;
  }
};

/**
 * The message types that can arrive between turns. Claude sends informational
 * messages after the `result` that closed the last turn. A turn opened for one
 * of them would wait for a `result` that never comes, and the session would
 * look busy for good. So a turn opened for one of these messages is closed
 * after that same message (spec 06 section 6.2, synthetic turns). `assistant`
 * and `stream_event` messages are model output, and a `result` ends their turn.
 *
 * The same holds for a subagent that woke by itself: a turn its `user` or
 * `system` message opens is closed after that message.
 */
const SELF_CONTAINED: ReadonlySet<string> = new Set(["user", "system"]);

/**
 * Returns the agent call a frame comes from: its `parent_tool_use_id`, or
 * `undefined` for a frame of the session's own agent or a frame that names no
 * agent.
 */
const readAgentCallId = (sdk: SDKMessage): string | undefined => {
  if (sdk.type !== "assistant" && sdk.type !== "user" && sdk.type !== "stream_event") {
    return undefined;
  }
  return cleanItemId(sdk.parent_tool_use_id);
};

/**
 * Checks whether a frame may link held frames to their subagent: a subagent's
 * `task_started`, the only frame that registers a subagent. After one, the
 * held frames it linked are emitted.
 */
const isSubagentStart = (sdk: SDKMessage): boolean =>
  sdk.type === "system" && sdk.subtype === "task_started" && sdk.task_type === "local_agent";

/**
 * Checks whether an event comes from opening a turn rather than from the
 * frame being normalized: the turn's start, a subagent's brief, and the
 * Requests the adapter deferred until the turn opened.
 */
const isTurnOpeningEvent = (event: ProviderEvent): boolean =>
  event._tag === "turn.started" ||
  event._tag === "request.opened" ||
  (event._tag === "item.started" && event.kind === "user_message") ||
  (event._tag === "item.completed" && event.kind === "user_message");

/**
 * Converts one SDK message into normalized events and returns them. The raw
 * payload is attached to the first event that comes from the message itself,
 * so the vendor message is always available without every delta carrying a
 * copy.
 *
 * A subagent's frame whose subagent is not known yet returns nothing: it is
 * held, and its events are returned after the `task_started` that links it.
 * At most `MAX_HELD_FRAMES` frames are held: the frame that would be one more
 * drops them all, itself included, and returns a warning that counts them.
 *
 * Never throws. A message with a known type but changed fields becomes an
 * `unknown` item, because the CLI ships weekly and a `TypeError` here would
 * take a live session down.
 */
export const normalize = (state: Normalizing, sdk: SDKMessage): ReadonlyArray<ProviderEvent> => {
  const out = normalizeFrame(state, sdk);
  if (isSubagentStart(sdk)) out.push(...releaseHeldFrames(state));
  return out;
};

/** Returns the agent a frame belongs to, or `"unknown"` for a subagent not known yet. */
const findTurnOwner = (state: Normalizing, sdk: SDKMessage): TurnOwner | "unknown" => {
  if (sdk.type === "system" && sdk.subtype === "permission_denied") {
    // A denial names the agent by its SubagentId, and names none for the
    // session's own agent. An id the registry does not know yet is held like
    // any other frame of an unknown subagent.
    const subagentId = cleanSubagentId(sdk.agent_id);
    if (subagentId === undefined) return undefined;
    return state.subagents.byId.get(subagentId) ?? "unknown";
  }
  const agentCallId = readAgentCallId(sdk);
  if (agentCallId === undefined) return undefined;
  return findSubagentByAgentCall(state.subagents, agentCallId) ?? "unknown";
};

const normalizeFrame = (state: Normalizing, sdk: SDKMessage): Emit => {
  const agent = findTurnOwner(state, sdk);
  if (agent === "unknown") return holdFrame(state, sdk);
  // A stream event would open an item in a turn that closes at once, and no
  // later frame would complete that item. The complete assistant message
  // that follows still reports what the subagent wrote.
  if (sdk.type === "stream_event" && agent?.stop === "stopped") return [];
  const out: Emit = [];
  // A subagent from an earlier process may send a frame before any
  // `task_started` in this one, and it must be introduced before its events.
  if (agent !== undefined) introduceSubagent(state, agent, out);
  // The introduction is not part of the message, so the raw payload never goes on it.
  const introductionCount = out.length;
  const unsolicited =
    agent === undefined ? state.turnId === undefined : agent.turn.phase === "idle";
  try {
    dispatch(state, sdk, agent, out);
  } catch {
    // Keep what changed the state of the session or a subagent, so a turn
    // opened before the failure is still reported as started, and drop the
    // rest of the message's partial output.
    const kept = out.filter(
      (event) => event._tag === "subagent.started" || isTurnOpeningEvent(event),
    );
    out.length = 0;
    out.push(...kept);
    emitUnknownItem(state, agent, out);
  }
  if (unsolicited) closeUnsolicitedTurn(state, sdk, agent, out);
  // There are thousands of deltas. A copy of the message on each one would
  // double the stream, and each delta already carries its text.
  if (sdk.type === "stream_event") return out;
  const at = out.findIndex(
    (event, index) => index >= introductionCount && !isTurnOpeningEvent(event),
  );
  const found = out[at];
  if (found !== undefined) {
    out[at] = { ...found, raw: { source: CLAUDE_SDK_MESSAGE, payload: toJson(sdk) } };
  }
  return out;
};

/**
 * Ends a turn that a message opened outside any turn, when nothing else will
 * end it (spec 06 section 6.2, synthetic turns):
 *
 * - a turn of the session's own agent in which the message produced nothing
 *   is dropped, as if it was never opened;
 * - a turn of a subagent the harness reported stopped is closed as
 *   `interrupted` after any message it still sends, other than a stream
 *   event, which is ignored. After a stop, the stopped call's
 *   `tool_result` arrives after the `task_notification` that closed the
 *   subagent's turn, and nothing else would ever close a turn it opened;
 * - a turn opened by a message in `SELF_CONTAINED` is closed after it.
 */
const closeUnsolicitedTurn = (
  state: Normalizing,
  sdk: SDKMessage,
  agent: TurnOwner,
  out: Emit,
): void => {
  if (agent === undefined) {
    if (state.turnId === undefined) return;
    if (out.every((event) => event._tag === "turn.started")) {
      out.length = 0;
      state.turnId = undefined;
    } else if (SELF_CONTAINED.has(sdk.type)) {
      closeTurn(state, out, undefined, state.turnId, "completed");
    }
    return;
  }
  if (agent.turn.phase !== "open") return;
  if (agent.stop === "stopped") {
    closeTurn(state, out, agent, agent.turn.turnId, "interrupted");
  } else if (SELF_CONTAINED.has(sdk.type)) {
    closeTurn(state, out, agent, agent.turn.turnId, "completed");
  }
};

/**
 * Holds a frame whose subagent is not known yet, and returns nothing. When
 * `MAX_HELD_FRAMES` frames are already held, drops them and this frame
 * instead, and returns a `runtime.warning` that counts them.
 *
 * The dropped frames may include the ones that would open a subagent's turn,
 * so a request from that subagent may never see its turn open. The registry
 * records their agent calls and drops the requests of unknown subagents, and
 * the adapter withdraws those requests.
 */
const holdFrame = (state: Normalizing, sdk: SDKMessage): Emit => {
  state.heldFrames.push(sdk);
  if (state.heldFrames.length <= MAX_HELD_FRAMES) return [];
  const dropped = state.heldFrames.splice(0);
  recordDroppedFrames(
    state.subagents,
    dropped.flatMap((frame) => readAgentCallId(frame) ?? []),
  );
  return [
    {
      _tag: "runtime.warning",
      eventId: state.mint(),
      sessionId: state.sessionId,
      at: state.now(),
      ...(state.turnId === undefined ? {} : { turnId: state.turnId }),
      message: `dropped ${dropped.length} messages from a subagent the harness never reported starting`,
    },
  ];
};

/**
 * Normalizes the held frames whose subagent is now known, in the order they
 * arrived, and returns their events. The frames still unknown stay held, in
 * order, for the `task_started` that links them.
 */
const releaseHeldFrames = (state: Normalizing): Emit => {
  const held = state.heldFrames.splice(0);
  const out: Emit = [];
  for (const frame of held) {
    if (findTurnOwner(state, frame) === "unknown") state.heldFrames.push(frame);
    else out.push(...normalizeFrame(state, frame));
  }
  return out;
};

const dispatch = (state: Normalizing, sdk: SDKMessage, agent: TurnOwner, out: Emit): void => {
  switch (sdk.type) {
    case "system":
      onSystem(state, sdk, agent, out);
      return;
    case "stream_event":
      onStreamEvent(state, sdk.event, agent, out);
      return;
    case "assistant":
      onAssistant(state, sdk, agent, out);
      return;
    case "user":
      onUser(state, sdk, agent, out);
      return;
    case "result":
      onResult(state, sdk, out);
      return;
    default:
      if (!TRIMMED.has(sdk.type)) emitUnknownItem(state, agent, out);
      return;
  }
};
