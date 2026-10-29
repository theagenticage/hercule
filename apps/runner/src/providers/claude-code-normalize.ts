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
 * Nothing throws. Every message type and `system` subtype of the pinned SDK has
 * an entry in `CLAUDE_MESSAGE_DECISIONS`: an item, a notice, a warning, or a
 * drop with its reason. A message with no entry, and a message of a known type
 * whose fields could not be read, becomes an `unknown` item that carries a
 * label and the raw payload (spec 06 section 6.7).
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ContextCompactionDetail,
  ContinuedSubagent,
  ItemKind,
  OutputSchema,
  ProviderEvent,
  StreamKind,
  StructuredResult,
  TextGenerationOutcome,
  TodoListDetail,
  TodoStep,
  TurnState,
  UnknownItemDetail,
  Usage,
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
import { buildEditedPathFields, type EditedPathFields } from "./edited-paths";
import {
  convertAdvisorResult,
  convertBashCodeExecutionResult,
  convertCodeExecutionResult,
  convertMcpResult,
  convertTextEditorResult,
  convertToolSearchResult,
  convertWebFetchResult,
  convertWebSearchResult,
  readFetchedPageUrl,
  truncateResultContent,
  type AssistantBlock,
  type AssistantBlockFor,
  type ConvertedResult,
} from "./claude-code-block-results";
import {
  applyTodoResult,
  buildTodoList,
  hasPendingTodoCall,
  isTodoTool,
  recordTodoCall,
  type TodoList,
} from "./claude-code-todo-list";
import { escapeControlCharacters } from "../report";
import { requireText, truncateFact, truncateMessage } from "./text";

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

/**
 * What one agent has of a todo list: the list the agent's todo tools keep, and
 * the `todo_list` item that shows it in the agent's open turn. An agent shows
 * one item per turn, which `closeTurn` completes and clears.
 */
interface AgentTodo {
  readonly list: TodoList;
  /**
   * The item the agent shows in its open turn, with the steps it showed last.
   * Those steps are what the item completes with, and what a new list is
   * compared with so an unchanged list adds no update.
   */
  open: { readonly itemId: string; readonly steps: ReadonlyArray<TodoStep> } | undefined;
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
   * Each open tool item, by `tool_use` id, so its `tool_result` completes it
   * with the same kind. Tool ids are unique across agents.
   */
  readonly tools: Map<string, OpenTool>;
  /** The session's subagents and their turns. */
  readonly subagents: SubagentRegistry;
  /**
   * Each agent's todo list, keyed by `buildStreamKey`. An agent has an entry
   * once it calls a todo tool, and from the start when the runner never saw its
   * list (see `buildNormalizingState`).
   */
  readonly todos: Map<string, AgentTodo>;
  /**
   * Frames from a subagent the registry does not know yet, in the order they
   * arrived: from an agent call no `task_started` has linked, or a denial
   * naming an unknown agent id. Each waits for the `task_started` that links
   * it, and at most `MAX_HELD_FRAMES` of them are kept.
   */
  readonly heldFrames: Array<SDKMessage>;
  /**
   * Tells the runner's log that Claude sent a message the table does not
   * decide, or one it could not read. `error` is what failed while reading a
   * message of a known type. It is called for every such message, so the
   * caller decides how often the log hears of one label.
   *
   * It must never throw: `normalize` promises never to throw, and it calls
   * this from inside its fallback for a message it cannot read. The adapter's
   * reporter forks the log effect, so it cannot throw.
   */
  readonly reportUnknownMessage: (label: string, error?: unknown) => void;
  /** The compaction in progress, or `undefined` when none is. */
  compaction: RunningCompaction | undefined;
  /**
   * Whether the last `rate_limit_event` said the usage limit blocks the
   * session. Claude repeats a blocked limit in every event, and the user is
   * warned only when the limit becomes blocked.
   */
  usageLimitBlocked: boolean;
}

/**
 * A `context_compaction` item that has started and not yet completed. Claude
 * reports a compaction in several messages (spec 06 section 6.3). What each
 * one does to the item, and who closes the turn:
 *
 * - `status` `compacting`: starts the item, in a synthetic turn if none is
 *   open (`openedTurn`). A second one while the item runs is ignored.
 * - `status` `null` with `compact_result: "failed"`: fails the item.
 * - `status` `null` with no `compact_result` and no `permissionMode`, before
 *   the boundary: fails the item. Claude reports success as `null` with
 *   `compact_result: "success"`, so a bare `null` means the compaction ended
 *   without a result.
 * - `compact_boundary`: records `boundary`, and starts the item first if no
 *   `compacting` status did. The item keeps running.
 * - The next conversation message of the session's own agent after the
 *   boundary: completes the item, with the summary if the message holds it.
 * - `result`, or the session exiting: completes the item with `boundary` if
 *   there is one and fails it if not.
 *
 * Only a failure or a completion by a conversation message closes the turn,
 * and only when `openedTurn`. A turn that was already open is closed by its own
 * `result`, and a session that exits leaves its turns open.
 */
interface RunningCompaction {
  readonly itemId: string;
  readonly turnId: string;
  /**
   * True when the compaction opened its turn because none was open. Such a
   * synthetic turn stays open until the compaction completes, and closes with
   * it.
   */
  readonly openedTurn: boolean;
  /**
   * What `compact_boundary` reported. `undefined` until that message arrives.
   * The item completes with it, plus the summary when the summary follows.
   */
  boundary: ContextCompactionDetail | undefined;
}

/** A tool item that has started and not yet completed. */
interface OpenTool {
  readonly kind: ItemKind;
  /** The turn the tool started in. Its result completes the item there, whatever turn is open then. */
  readonly turnId: string;
  /** The subagent the tool started in, or `undefined` for the session's own agent. */
  readonly subagentId: string | undefined;
  /**
   * The edited paths of a `file_change` tool, put on its `item.completed`.
   * Claude Code names the path only when the tool starts. Dropped when the
   * turn is interrupted, because an interrupted edit may not have happened.
   */
  editedPaths: EditedPathFields | undefined;
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
 *
 * `resumed` says the session continues an earlier one (a resume or a fork). The
 * runner never saw that session's todo list, so the session's own agent and
 * every seeded subagent start with an unknown list.
 */
export const buildNormalizingState = (
  sessionId: string,
  mint: () => string,
  now: () => string,
  outputSchema: OutputSchema | undefined,
  reportUnknownMessage: Normalizing["reportUnknownMessage"],
  seeded?: ReadonlyArray<ContinuedSubagent>,
  resumed = false,
): Normalizing => {
  const todos = new Map<string, AgentTodo>();
  const keysOfUnknownLists = [
    ...(resumed ? [buildStreamKey(undefined)] : []),
    ...(seeded ?? []).map((subagent) => subagent.subagentId),
  ];
  for (const key of keysOfUnknownLists) {
    todos.set(key, { list: buildTodoList(true), open: undefined });
  }
  return {
    sessionId,
    mint,
    now,
    outputSchema,
    turnId: undefined,
    streams: new Map(),
    tools: new Map(),
    subagents: buildSubagentRegistry(seeded),
    todos,
    heldFrames: [],
    reportUnknownMessage,
    compaction: undefined,
    usageLimitBlocked: false,
  };
};

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
 * Returns the agent's todo state, creating it the first time with a known,
 * empty list. An agent whose list the runner never saw already has its entry,
 * with an unknown list (see `buildNormalizingState`).
 */
const ensureAgentTodo = (state: Normalizing, agent: TurnOwner): AgentTodo => {
  const key = buildStreamKey(agent);
  const found = state.todos.get(key);
  if (found !== undefined) return found;
  const created: AgentTodo = { list: buildTodoList(false), open: undefined };
  state.todos.set(key, created);
  return created;
};

/**
 * The item kind for each Claude tool name. Only the tool families the
 * taxonomy has an item kind for are mapped: shell commands, file changes, file
 * reads, file searches, web search and fetch, subagents and plans. Every other tool is a
 * plain `tool_call` (spec 06 section 6.3).
 */
const TOOL_KINDS: Readonly<Record<string, ItemKind>> = {
  Bash: "command_execution",
  BashOutput: "command_execution",
  KillShell: "command_execution",
  Shell: "command_execution",
  Edit: "file_change",
  MultiEdit: "file_change",
  Write: "file_change",
  NotebookEdit: "file_change",
  Patch: "file_change",
  Read: "file_read",
  Grep: "file_search",
  Glob: "file_search",
  LS: "file_search",
  WebSearch: "web_search",
  WebFetch: "web_search",
  Task: "subagent",
  Agent: "subagent",
  SendMessage: "subagent",
  ExitPlanMode: "plan",
};

/**
 * The tools that can write files: those whose items are commands or file
 * changes, the two kinds the edit watch keeps windows for (spec 19 section
 * 4.1). Each waits for the gate that marks its start.
 */
export const FILE_WRITING_TOOLS: ReadonlyArray<string> = Object.entries(TOOL_KINDS)
  .filter(([, kind]) => kind === "command_execution" || kind === "file_change")
  .map(([name]) => name);

/**
 * Returns the item kind for a Claude tool name, or `tool_call` for a tool with
 * no specific kind. The adapter also uses it to pick the approval request kind,
 * so one table decides both and the two cannot disagree. Only the table's own
 * keys count, so a tool named like an object method, such as `constructor`,
 * is still a `tool_call`.
 */
export const classifyTool = (name: string): ItemKind =>
  Object.hasOwn(TOOL_KINDS, name) ? TOOL_KINDS[name]! : "tool_call";

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
export const cleanItemId = (raw: unknown): string | undefined =>
  typeof raw === "string" && raw !== "" ? truncateFact(raw) : undefined;

/** Returns a tool input's string field, or `undefined` when it is missing or not a string. */
const readInputString = (input: unknown, key: string): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
};

/**
 * Returns a tool input's string field cut to the protocol's bounds, or
 * `undefined` when it is missing, not a string, or empty.
 */
const readInputFact = (input: unknown, key: string): string | undefined => {
  const value = readInputString(input, key);
  return value === undefined || value === "" ? undefined : truncateFact(value);
};

/**
 * Builds the fixed detail fields of a file read or file search item, so a
 * client can show the path or pattern without digging through `input`:
 *
 * - `file_read`: `path`, from the tool's `file_path`.
 * - `file_search`: `pattern` and `path`. `LS` has no pattern, and `Glob` and
 *   `Grep` may leave out the path to search the workspace.
 *
 * A field is left out when the input does not hold it. Returns no fields for
 * any other kind.
 */
const buildFileFields = (kind: ItemKind, input: unknown): Record<string, string> => {
  if (kind === "file_read") {
    const path = readInputFact(input, "file_path");
    return path === undefined ? {} : { path };
  }
  if (kind === "file_search") {
    const pattern = readInputFact(input, "pattern");
    const path = readInputFact(input, "path");
    return {
      ...(pattern === undefined ? {} : { pattern }),
      ...(path === undefined ? {} : { path }),
    };
  }
  return {};
};

/**
 * The detail field that holds what a web tool asks for: the search query or the
 * URL to fetch. Claude's own `WebSearch` and `WebFetch` tools and the web tools
 * Anthropic runs on its servers (`web_search`, `web_fetch`) name the same input
 * fields, so every one of them shows up in the same two detail fields.
 */
const WEB_TOOL_FIELDS: Readonly<Record<string, "query" | "url">> = {
  WebSearch: "query",
  web_search: "query",
  WebFetch: "url",
  web_fetch: "url",
};

/**
 * Builds the fixed detail field of a web search item, so a client can show the
 * query or the URL without knowing which tool Claude called: `query` for a
 * search and `url` for a fetch, each from the tool's input field of the same
 * name. Returns no fields for any other tool or when the input holds none.
 */
const buildWebFields = (toolName: string, input: unknown): Record<string, string> => {
  if (!Object.hasOwn(WEB_TOOL_FIELDS, toolName)) return {};
  const field = WEB_TOOL_FIELDS[toolName]!;
  const value = readInputFact(input, field);
  return value === undefined ? {} : { [field]: value };
};

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
 * and needs the kind its item started with. An interrupted turn forgets the
 * edited paths of its tools, so a late result reports no edit.
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
  completeTodoItem(state, out, agent, turnId);
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
  if (turnState === "interrupted") {
    // The session's own agent being interrupted stops its subagents' tools too.
    for (const tool of state.tools.values()) {
      if (agent === undefined || tool.turnId === turnId) tool.editedPaths = undefined;
    }
  }
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

const buildItemUpdated = (
  state: Normalizing,
  turn: TurnRef,
  itemId: string,
  kind: ItemKind,
  detail: unknown,
): ProviderEvent => ({
  _tag: "item.updated",
  eventId: state.mint(),
  sessionId: state.sessionId,
  at: state.now(),
  ...buildSubagentAttribution(turn.subagentId),
  turnId: turn.turnId,
  itemId,
  kind,
  detail: toJson(detail),
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
 * Builds the `{ type }` or `{ type }/{ subtype }` name of a Claude message, the
 * key of its entry in `CLAUDE_MESSAGE_DECISIONS` and the end of its label.
 * Only a `system` message has a subtype in the key. Returns a placeholder for
 * a message with no usable `type`. Never throws, whatever the message holds.
 */
const buildClaudeMessageKey = (message: unknown): string => {
  const type = readInputString(message, "type");
  if (type === undefined || type === "") return "message with no type";
  const subtype = type === "system" ? readInputString(message, "subtype") : undefined;
  return subtype === undefined || subtype === "" ? type : `${type}/${subtype}`;
};

/**
 * Builds the label of an `unknown` item for a message, such as
 * `claude: system/foo_bar`. The type and subtype are text from Claude, so
 * control and format characters are written as escapes: a label with a line
 * break or a direction override would otherwise change how a client draws it.
 * Never throws, whatever the message holds.
 */
const buildUnknownLabel = (message: unknown): string =>
  truncateFact(`claude: ${escapeControlCharacters(buildClaudeMessageKey(message))}`);

/**
 * Emits an `unknown` item, in the agent's turn, for a message this adapter
 * cannot show: its type has no entry in `CLAUDE_MESSAGE_DECISIONS`, or its
 * fields could not be read (`error` is what failed). The item carries the
 * message's label, and the runner's log hears of the message through
 * `reportUnknownMessage`. `normalize` attaches the raw payload.
 */
const emitUnknownItem = (
  state: Normalizing,
  agent: TurnOwner,
  out: Emit,
  sdk: unknown,
  error?: unknown,
): void => emitLabelledUnknownItem(state, agent, out, buildUnknownLabel(sdk), error);

/**
 * Emits an `unknown` item with the given label, in the agent's turn, and tells
 * the runner's log about it through `reportUnknownMessage`. `model` goes on the
 * turn if this item opens it.
 */
const emitLabelledUnknownItem = (
  state: Normalizing,
  agent: TurnOwner,
  out: Emit,
  label: string,
  error?: unknown,
  model?: string,
): void => {
  state.reportUnknownMessage(label, error);
  const turn = ensureAgentTurn(state, agent, out, model);
  const itemId = state.mint();
  const detail: UnknownItemDetail = { label };
  out.push(buildItemStarted(state, turn, itemId, "unknown", detail));
  out.push(buildItemCompleted(state, turn, itemId, "unknown", "completed", detail));
};

/** The two events that tell the user something without being an item. */
type RuntimeEventTag = "runtime.warning" | "runtime.notice";

/**
 * Builds a `runtime.notice` (neutral information) or a `runtime.warning`
 * (something went wrong, but the session goes on). With a `subagentId` the
 * event names that subagent and no turn. Without one it names the open turn of
 * the session's own agent, if there is one, and never opens one: a notice
 * between turns is drawn without a turn around it (spec 06 section 6.2).
 */
export const buildRuntimeEvent = (
  state: Normalizing,
  tag: RuntimeEventTag,
  text: string,
  subagentId?: string,
): ProviderEvent => ({
  _tag: tag,
  eventId: state.mint(),
  sessionId: state.sessionId,
  at: state.now(),
  ...(subagentId !== undefined
    ? { subagentId }
    : state.turnId === undefined
      ? {}
      : { turnId: state.turnId }),
  message: truncateMessage(text),
});

/** Adds a notice or a warning to `out`. Adds nothing for an empty text. */
const emitRuntimeEvent = (state: Normalizing, out: Emit, tag: RuntimeEventTag, text: string) => {
  if (text !== "") out.push(buildRuntimeEvent(state, tag, text));
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
      : { description: truncateMessage(description) }),
    ...(agentType === undefined || agentType === "" ? {} : { agentType: truncateFact(agentType) }),
  };
  subagent.introduced = true;
  out.push(started);
};

const onStreamEvent = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { type: "stream_event" }>,
  out: Emit,
  agent: TurnOwner,
): void => {
  const event = sdk.event;
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
      // Only text and thinking stream, because they are the only blocks whose
      // text a client wants before the block is done. Every other block
      // (`tool_use`, `server_tool_use`, `mcp_tool_use` and every result block)
      // streams as partial JSON, which the taxonomy has no kind for, and the
      // SDK sends it whole in the assistant message it emits for each completed
      // block (spec 06 section 6.3). Reading it here too would show the same
      // call twice.
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

/**
 * Returns the `path` field for the file an `Edit`, `MultiEdit`, `Write` or
 * `NotebookEdit` call changes, from its `file_path` or `notebook_path`, or
 * undefined when the input names none or the path is too long. The path is
 * written whole, because Edit Overlaps compare it with other sessions' paths.
 */
const readEditedPaths = (input: unknown): EditedPathFields | undefined => {
  const path = readInputString(input, "file_path") ?? readInputString(input, "notebook_path");
  return path === undefined ? undefined : buildEditedPathFields([path]);
};

/**
 * What a handler in `CLAUDE_BLOCK_DECISIONS` needs besides the block: where it
 * writes events, whose block it is, and the facts of the message around it.
 */
interface BlockScope {
  readonly state: Normalizing;
  readonly out: Emit;
  readonly agent: TurnOwner;
  /** The model that wrote the message. A turn the block opens carries it. */
  readonly model: string | undefined;
  /**
   * Whether the message repeats blocks that already streamed. Only text and
   * thinking stream, so only their handlers read this.
   */
  readonly echo: boolean;
}

/** Opens the agent's turn if none is open, and returns it. Only a block that emits an event calls it. */
const openBlockTurn = (scope: BlockScope): TurnRef =>
  ensureAgentTurn(scope.state, scope.agent, scope.out, scope.model);

/**
 * Handles a `text` block. Text that streamed was already emitted, and the
 * complete message repeats it; only a message that never streamed still needs
 * it reported. An empty block would only add a blank entry to the transcript.
 */
const emitAssistantText = (block: AssistantBlockFor<"text">, scope: BlockScope): void => {
  if (scope.echo || block.text === "") return;
  scope.out.push(
    ...buildWholeItem(
      scope.state,
      openBlockTurn(scope),
      scope.state.mint(),
      "assistant_message",
      "assistant_text",
      block.text,
    ),
  );
};

/**
 * Handles a `thinking` block, like `emitAssistantText`. A thinking block whose
 * text the harness leaves out is empty and is skipped.
 */
const emitAssistantThinking = (block: AssistantBlockFor<"thinking">, scope: BlockScope): void => {
  if (scope.echo || block.thinking === "") return;
  scope.out.push(
    ...buildWholeItem(
      scope.state,
      openBlockTurn(scope),
      scope.state.mint(),
      "reasoning",
      "reasoning_text",
      block.thinking,
    ),
  );
};

/** Handles a `tool_use` block: starts the item for a tool that runs on this machine. */
const startLocalTool = (block: AssistantBlockFor<"tool_use">, scope: BlockScope): void => {
  const { state, out, agent } = scope;
  const turn = openBlockTurn(scope);
  const kind = classifyTool(block.name);
  const itemId = cleanItemId(block.id) ?? state.mint();
  if (isTodoTool(block.name)) {
    // The todo list is one row that the results update, not a row per call.
    recordTodoCall(
      ensureAgentTodo(state, agent).list,
      itemId,
      block.name,
      block.input,
      turn.turnId,
    );
    return;
  }
  const editedPaths = kind === "file_change" ? readEditedPaths(block.input) : undefined;
  const subagentIds = listMessagedSubagents(state, block.name, block.input);
  // Built before the tool is recorded: a read above that throws must not leave
  // an open tool whose item never started.
  const started = buildItemStarted(state, turn, itemId, kind, {
    name: block.name,
    input: block.input,
    ...buildFileFields(kind, block.input),
    ...buildWebFields(block.name, block.input),
    ...editedPaths,
    ...(kind === "tool_call" ? { kind: isMcp(block.name) ? "mcp" : "native" } : {}),
    ...(subagentIds.length === 0 ? {} : { subagentIds }),
  });
  state.tools.set(itemId, { kind, turnId: turn.turnId, subagentId: turn.subagentId, editedPaths });
  if (AGENT_TOOLS.has(block.name)) {
    recordAgentCall(
      state.subagents,
      itemId,
      agent?.subagentId,
      readInputString(block.input, "name"),
    );
  }
  out.push(started);
};

/** The server tools that are a web search item. Every other server tool is a plain `tool_call`. */
const SERVER_WEB_TOOLS: ReadonlySet<string> = new Set(["web_search", "web_fetch"]);

/**
 * Handles a `server_tool_use` block: a tool Anthropic runs on its own servers.
 * Its name never goes through `classifyTool`, because that table names tools
 * that run on this machine, and a server tool must not open an edit-watch
 * window for files it cannot touch.
 */
const startServerTool = (block: AssistantBlockFor<"server_tool_use">, scope: BlockScope): void => {
  const { state } = scope;
  const turn = openBlockTurn(scope);
  const kind: ItemKind = SERVER_WEB_TOOLS.has(block.name) ? "web_search" : "tool_call";
  const itemId = cleanItemId(block.id) ?? state.mint();
  // Built before the tool is recorded, like in `startLocalTool`.
  const started = buildItemStarted(state, turn, itemId, kind, {
    name: block.name,
    input: block.input,
    ...buildWebFields(block.name, block.input),
    ...(kind === "tool_call" ? { kind: "native" } : {}),
  });
  state.tools.set(itemId, {
    kind,
    turnId: turn.turnId,
    subagentId: turn.subagentId,
    editedPaths: undefined,
  });
  scope.out.push(started);
};

/** Handles an `mcp_tool_use` block: a call to an MCP server that Anthropic's API makes. */
const startMcpTool = (block: AssistantBlockFor<"mcp_tool_use">, scope: BlockScope): void => {
  const { state } = scope;
  const turn = openBlockTurn(scope);
  const itemId = cleanItemId(block.id) ?? state.mint();
  // Built before the tool is recorded, like in `startLocalTool`:
  // `truncateFact` throws when the server name is not text.
  const started = buildItemStarted(state, turn, itemId, "tool_call", {
    name: block.name,
    input: block.input,
    kind: "mcp",
    server: truncateFact(block.server_name),
  });
  state.tools.set(itemId, {
    kind: "tool_call",
    turnId: turn.turnId,
    subagentId: turn.subagentId,
    editedPaths: undefined,
  });
  scope.out.push(started);
};

/** Checks whether two lists of steps hold the same text and status in the same order. */
const areStepsEqual = (left: ReadonlyArray<TodoStep>, right: ReadonlyArray<TodoStep>): boolean =>
  left.length === right.length &&
  left.every(
    (step, index) => step.text === right[index]?.text && step.status === right[index].status,
  );

/** Returns the id of the subagent's open turn, or `undefined` when it has none open. */
const readOpenTurnId = (agent: Subagent): string | undefined =>
  agent.turn.phase === "open" ? agent.turn.turnId : undefined;

/** Checks whether `turnId` is the open turn of the agent. */
const isAgentTurnOpen = (state: Normalizing, agent: TurnOwner, turnId: string): boolean =>
  (agent === undefined ? state.turnId : readOpenTurnId(agent)) === turnId;

/**
 * Shows the agent's whole todo list. The first list in a turn starts the
 * agent's `todo_list` item, and every later one that differs from the steps the
 * item shows replaces its detail with `item.updated`. A list equal to what the
 * item shows adds nothing.
 *
 * Shows nothing when `turnId` is not the agent's open turn: a result that
 * arrives after its turn ended must not touch a later turn's item, and a todo
 * result never opens a turn.
 */
const publishTodoList = (
  state: Normalizing,
  out: Emit,
  agent: TurnOwner,
  turnId: string,
  steps: ReadonlyArray<TodoStep>,
): void => {
  if (!isAgentTurnOpen(state, agent, turnId)) return;
  const todo = ensureAgentTodo(state, agent);
  const turn: TurnRef = { turnId, subagentId: agent?.subagentId };
  const detail: TodoListDetail = { steps };
  if (todo.open === undefined) {
    const itemId = state.mint();
    todo.open = { itemId, steps };
    out.push(buildItemStarted(state, turn, itemId, "todo_list", detail));
  } else if (!areStepsEqual(todo.open.steps, steps)) {
    todo.open = { itemId: todo.open.itemId, steps };
    out.push(buildItemUpdated(state, turn, todo.open.itemId, "todo_list", detail));
  }
};

/**
 * Completes the agent's open `todo_list` item with the steps it last showed,
 * and forgets the item. Called when the agent's turn `turnId` ends, however it
 * ends. Does nothing for another agent's item or when the agent has none open.
 */
const completeTodoItem = (
  state: Normalizing,
  out: Emit,
  agent: TurnOwner,
  turnId: string,
): void => {
  const todo = state.todos.get(buildStreamKey(agent));
  if (todo?.open === undefined) return;
  const { itemId, steps } = todo.open;
  todo.open = undefined;
  const detail: TodoListDetail = { steps };
  out.push(
    buildItemCompleted(
      state,
      { turnId, subagentId: agent?.subagentId },
      itemId,
      "todo_list",
      "completed",
      detail,
    ),
  );
};

/**
 * Shows a todo tool call that failed or whose result could not be used, as a
 * failed tool row in the call's own turn, so the call never goes unseen.
 *
 * When the call's turn is no longer the agent's open turn, the row would start
 * an item in a finished turn, which a client draws as a stretch of work that
 * never ends. The failure goes to the runner's log instead, and nothing is
 * emitted.
 */
const emitFailedTodoCall = (
  state: Normalizing,
  out: Emit,
  agent: TurnOwner,
  call: {
    readonly turnId: string;
    readonly toolUseId: string;
    readonly name: string;
    readonly input: unknown;
    readonly reason: string;
  },
): void => {
  if (!isAgentTurnOpen(state, agent, call.turnId)) {
    state.reportUnknownMessage(
      `claude: user/tool_result of a failed ${call.name} after its turn ended`,
      new Error(call.reason),
    );
    return;
  }
  const turn: TurnRef = { turnId: call.turnId, subagentId: agent?.subagentId };
  const started = { name: call.name, input: call.input, kind: "native" };
  out.push(buildItemStarted(state, turn, call.toolUseId, "tool_call", started));
  out.push(
    buildItemCompleted(state, turn, call.toolUseId, "tool_call", "failed", {
      content: call.reason,
    }),
  );
};

/** The result of a tool call, as `completeTool` needs it. */
interface ToolOutcome extends ConvertedResult {
  /** The id of the call the result answers: a `tool_use_id`. Anything but a non-empty string gets a new id. */
  readonly toolUseId: unknown;
  /** The item to start first when the call was never seen. */
  readonly orphan: { readonly kind: ItemKind; readonly detail: object };
}

/**
 * Completes the item of the call a result answers, found by its id, and forgets
 * the call. The item completes in the turn and the agent it started in, not in
 * whatever turn is open now: a result can arrive after its turn ended, and a
 * client finds an item inside its own turn.
 *
 * A result whose call was never seen (it started before this process, or the
 * harness left the call out) starts an item of its own, kind and detail from
 * `outcome.orphan`, and completes it at once, in the agent's current turn.
 * Opening that turn is the only reason this function ever opens one.
 */
const completeTool = (
  state: Normalizing,
  out: Emit,
  agent: TurnOwner,
  outcome: ToolOutcome,
): void => {
  const itemId = cleanItemId(outcome.toolUseId) ?? state.mint();
  const open = state.tools.get(itemId);
  state.tools.delete(itemId);
  const status = outcome.failed ? "failed" : "completed";
  const detail = {
    ...open?.editedPaths,
    ...(outcome.content === undefined ? {} : { content: outcome.content }),
  };
  if (open !== undefined) {
    const turn: TurnRef = { turnId: open.turnId, subagentId: open.subagentId };
    out.push(buildItemCompleted(state, turn, itemId, open.kind, status, detail));
    return;
  }
  const turn = ensureAgentTurn(state, agent, out);
  const { kind } = outcome.orphan;
  out.push(buildItemStarted(state, turn, itemId, kind, outcome.orphan.detail));
  out.push(buildItemCompleted(state, turn, itemId, kind, status, detail));
};

/** The item that opens for a result whose call was never seen, by the kind of call. */
const ORPHAN_WEB_SEARCH = { kind: "web_search", detail: {} } as const;
const ORPHAN_NATIVE_TOOL = { kind: "tool_call", detail: { kind: "native" } } as const;
const ORPHAN_MCP_TOOL = { kind: "tool_call", detail: { kind: "mcp" } } as const;

/**
 * Builds the item that opens for a `web_fetch_tool_result` whose call was never
 * seen. A result that holds the fetched URL is a page fetch, which a client
 * draws as "Fetched <url>". An error result holds no URL, and drawing it as a
 * web search would be wrong, so it becomes a plain native tool call named
 * `web_fetch`.
 */
const buildOrphanWebFetch = (
  block: AssistantBlockFor<"web_fetch_tool_result">,
): ToolOutcome["orphan"] => {
  const url = readFetchedPageUrl(block);
  return url === undefined
    ? { kind: "tool_call", detail: { name: "web_fetch", kind: "native" } }
    : { kind: "web_search", detail: { name: "web_fetch", url } };
};

/**
 * Builds the handler of one kind of result block: it converts the block with
 * `convert` and completes the call the block names. `orphan` is the item to
 * show when that call was never seen: fixed for the kind of block, or built
 * from the block.
 */
const buildResultHandler =
  <Block extends { readonly tool_use_id: string }>(
    orphan: ToolOutcome["orphan"] | ((block: Block) => ToolOutcome["orphan"]),
    convert: (block: Block) => ConvertedResult,
  ) =>
  (block: Block, scope: BlockScope): void =>
    completeTool(scope.state, scope.out, scope.agent, {
      ...convert(block),
      toolUseId: block.tool_use_id,
      orphan: typeof orphan === "function" ? orphan(block) : orphan,
    });

/**
 * Builds the label of an `unknown` item for a content block of an assistant
 * message, such as `claude: assistant/container_upload`. The type is text from
 * Claude, so it is escaped like a message's type (`buildUnknownLabel`).
 */
const buildUnknownBlockLabel = (block: unknown): string => {
  const type = readInputString(block, "type");
  const name = type === undefined || type === "" ? "block with no type" : type;
  return truncateFact(`claude: assistant/${escapeControlCharacters(name)}`);
};

/** Emits an `unknown` item for a content block this adapter cannot show. */
const emitUnknownBlock = (scope: BlockScope, block: unknown, error?: unknown): void =>
  emitLabelledUnknownItem(
    scope.state,
    scope.agent,
    scope.out,
    buildUnknownBlockLabel(block),
    error,
    scope.model,
  );

/**
 * Runs the decision for one content block. A block with no entry in the table,
 * such as a type a newer `claude` binary added, becomes a labelled `unknown`
 * item. So does a block whose handler throws because a field is not what the
 * SDK promises. In that case the events the handler had already emitted are
 * discarded, except those that opened a turn, so the block's siblings are
 * still reported and the block itself shows once.
 */
const handleBlock = (block: AssistantBlock, scope: BlockScope): void => {
  const type = readInputString(block, "type") ?? "";
  const decision = Object.hasOwn(DECISIONS_BY_BLOCK_TYPE, type)
    ? DECISIONS_BY_BLOCK_TYPE[type]
    : undefined;
  if (decision === undefined) {
    emitUnknownBlock(scope, block);
    return;
  }
  if (typeof decision !== "function") return;
  const { out } = scope;
  const start = out.length;
  try {
    decision(block, scope);
  } catch (error) {
    const kept = out.splice(start).filter(isTurnOpeningEvent);
    out.push(...kept);
    const label = buildUnknownBlockLabel(block);
    const toolUseId = cleanItemId(readInputString(block, "tool_use_id"));
    if (toolUseId !== undefined && scope.state.tools.has(toolUseId)) {
      // The block is the result of a call that is still running. A failed row
      // for that call says more than a second, unrelated `unknown` row, and it
      // stops the call from running for ever.
      scope.state.reportUnknownMessage(label, error);
      completeTool(scope.state, out, scope.agent, {
        toolUseId,
        failed: true,
        content: `The result could not be read (${label})`,
        orphan: ORPHAN_NATIVE_TOOL,
      });
    } else {
      emitUnknownBlock(scope, block, error);
    }
  }
};

const onAssistant = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { type: "assistant" }>,
  out: Emit,
  agent: TurnOwner,
): void => {
  const scope: BlockScope = {
    state,
    out,
    agent,
    model: sdk.message.model,
    echo: ensureAgentStream(state, agent).streamed.has(sdk.message.id),
  };
  for (const block of sdk.message.content) handleBlock(block, scope);
  if (sdk.error !== undefined) {
    const turn = openBlockTurn(scope);
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
 * handles `tool_result` blocks, each of which completes a tool item.
 */
const onUser = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { type: "user" }>,
  out: Emit,
  agent: TurnOwner,
): void => {
  const content = sdk.message.content;
  if (typeof content === "string") return;
  // `tool_use_result` is the structured result of the whole message, not of one
  // block. With several results in the message it cannot be told which block it
  // belongs to, so it is used only when the message holds exactly one.
  const structuredResult =
    content.filter((block) => block.type === "tool_result").length === 1
      ? sdk.tool_use_result
      : undefined;
  for (const block of content) {
    if (block.type !== "tool_result") continue;
    const toolUseId = cleanItemId(block.tool_use_id);
    const todo = state.todos.get(buildStreamKey(agent));
    if (toolUseId !== undefined && todo !== undefined) {
      const outcome = applyTodoResult(
        todo.list,
        toolUseId,
        { isError: block.is_error === true, content: block.content },
        structuredResult,
      );
      if (outcome.kind === "changed") {
        publishTodoList(state, out, agent, outcome.turnId, outcome.steps);
        continue;
      }
      if (outcome.kind === "failed") {
        emitFailedTodoCall(state, out, agent, { ...outcome, toolUseId });
        continue;
      }
      if (outcome.kind === "unchanged") continue;
    }
    completeTool(state, out, agent, {
      toolUseId: block.tool_use_id,
      failed: block.is_error === true,
      // Truncated because a `Read` of a big file returns it whole; `raw` keeps all of it.
      content: truncateResultContent(block.content),
      orphan: ORPHAN_NATIVE_TOOL,
    });
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
    return truncateMessage(sdk.errors.join("; "));
  if (sdk.subtype === "success" && sdk.result !== "") return truncateMessage(sdk.result);
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

/**
 * The SDK's result subtype for a run that was cut off at its turn limit. A
 * text generation has no tools, so the only reason for a second turn is a
 * retry after the model's structured output did not match the schema.
 */
const TURN_LIMIT_REACHED = "error_max_turns";

/**
 * Decides how a text generation ended, from the `result` message of its one
 * query. Returns:
 *
 * - `ok` when the structured output matches `schema`;
 * - `invalid-output` when the harness answered but gave no output, an output
 *   that does not match `schema`, or ran out of retries trying;
 * - `failed` for everything else, such as a login error or an API error. Its
 *   message holds only what the harness reported, never text the model wrote.
 *
 * The usage is null when the result lists no model, because then the harness
 * reported no token counts.
 */
export const decideTextGenerationOutcome = (
  schema: OutputSchema,
  sdk: Extract<SDKMessage, { type: "result" }>,
): TextGenerationOutcome => {
  const answer =
    sdk.subtype === TURN_LIMIT_REACHED
      ? { missing: "the harness did not produce an output that matches the schema" }
      : readHarnessAnswer(sdk, readTurnState(sdk));
  if (answer === undefined) {
    // An interrupted turn's result text is what the model had written so far.
    // A failure message is stored and shown to the user, and model output must
    // never reach it, so that text is left out.
    return {
      outcome: "failed",
      message:
        readTurnState(sdk) === "interrupted"
          ? "the harness stopped the turn before it answered"
          : describeFailure(sdk),
    };
  }
  const judged = judgeAnswer(schema, answer);
  if (judged.outcome !== "ok") return { outcome: "invalid-output", reason: judged.reason };
  return {
    outcome: "ok",
    value: judged.value,
    usage: Object.keys(sdk.modelUsage).length === 0 ? null : readUsage(sdk),
  };
};

const onResult = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { type: "result" }>,
  out: Emit,
): void => {
  const usage = readUsage(sdk);
  const turnState = readTurnState(sdk);
  const usageUpdate: ProviderEvent = {
    _tag: "session.usage.updated",
    eventId: state.mint(),
    sessionId: state.sessionId,
    at: state.now(),
    usage,
  };
  // A slash command Claude runs itself, such as `/compact`, ends with a
  // result that counts no model turn. When no turn is open, because the
  // compaction's own synthetic turn closed with the compaction, the result has
  // no turn to close, and opening one would leave an empty turn behind.
  if (state.turnId === undefined && sdk.num_turns === 0 && turnState === "completed") {
    out.push(usageUpdate);
    return;
  }
  const { turnId } = ensureAgentTurn(state, undefined, out);
  const structuredResult = judgeTurn(state, sdk, turnState);
  completeCompactionAtEnd(state, out);
  out.push(usageUpdate);
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
    out.push(
      buildRuntimeEvent(
        state,
        "runtime.warning",
        `the harness named a subagent "${sdk.task_id}", which the protocol does not accept, so it is reported as "${subagentId}"`,
        subagentId,
      ),
    );
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

/**
 * Starts the `context_compaction` item in the session's own agent's turn, tracks
 * it in `state.compaction`, and returns it. `detail` is what is known so far.
 * Known limit: compaction names no agent, so a subagent's is reported as the
 * session's own agent's (spec 06 section 13.6).
 */
const startCompaction = (
  state: Normalizing,
  out: Emit,
  detail: ContextCompactionDetail,
): RunningCompaction => {
  const openedTurn = state.turnId === undefined;
  const turn = ensureAgentTurn(state, undefined, out);
  const itemId = state.mint();
  out.push(buildItemStarted(state, turn, itemId, "context_compaction", detail));
  const compaction: RunningCompaction = {
    itemId,
    turnId: turn.turnId,
    openedTurn,
    boundary: undefined,
  };
  state.compaction = compaction;
  return compaction;
};

/**
 * Completes the tracked compaction item and stops tracking it. Does nothing
 * when no compaction is tracked. Leaves the turn alone. Returns the compaction
 * that completed.
 */
const completeCompactionItem = (
  state: Normalizing,
  out: Emit,
  status: "completed" | "failed",
  detail?: ContextCompactionDetail,
): RunningCompaction | undefined => {
  const compaction = state.compaction;
  if (compaction === undefined) return undefined;
  state.compaction = undefined;
  out.push(
    buildItemCompleted(
      state,
      { turnId: compaction.turnId, subagentId: undefined },
      compaction.itemId,
      "context_compaction",
      status,
      detail,
    ),
  );
  return compaction;
};

/** Completes the tracked compaction item, then closes its turn if the compaction opened it. */
const completeCompaction = (
  state: Normalizing,
  out: Emit,
  status: "completed" | "failed",
  detail?: ContextCompactionDetail,
): void => {
  const compaction = completeCompactionItem(state, out, status, detail);
  if (compaction?.openedTurn === true && state.turnId === compaction.turnId) {
    closeTurn(state, out, undefined, compaction.turnId, "completed");
  }
};

/**
 * Completes the tracked compaction at a `result` or at the end of the session,
 * when no later message will. A compaction past its boundary completes without
 * a summary. One without a boundary fails. Leaves the turn to the caller.
 */
export const completeCompactionAtEnd = (state: Normalizing, out: Array<ProviderEvent>): void => {
  const boundary = state.compaction?.boundary;
  if (boundary === undefined) completeCompactionItem(state, out, "failed");
  else completeCompactionItem(state, out, "completed", boundary);
};

/**
 * Returns the summary Claude writes after a compaction: the text of a
 * synthetic user message from the session's own agent (`parent_tool_use_id` is
 * null) whose content is a plain string. Returns `undefined` for any other
 * message. Measured on the real CLI (spec 06 section 6.3).
 */
const readCompactionSummary = (sdk: SDKMessage): string | undefined => {
  if (sdk.type !== "user" || sdk.parent_tool_use_id !== null || sdk.isSynthetic !== true) {
    return undefined;
  }
  return readInputString(sdk.message, "content");
};

/**
 * Checks whether a message is part of the conversation: a `user`, `assistant`
 * or `stream_event` message. Every `system` message and every other top-level
 * type, such as a rate limit event, passes a pending compaction by.
 */
const isConversationMessage = (sdk: SDKMessage): boolean =>
  sdk.type === "user" || sdk.type === "assistant" || sdk.type === "stream_event";

/**
 * Completes a compaction that has passed its boundary, on the next
 * conversation message (`isConversationMessage`). The summary is added when
 * the message is the summary message. Does nothing for any other message,
 * before the boundary, or when no compaction is tracked.
 */
const completeCompactionAfterBoundary = (state: Normalizing, sdk: SDKMessage, out: Emit): void => {
  const boundary = state.compaction?.boundary;
  if (boundary === undefined || !isConversationMessage(sdk)) return;
  const summary = readCompactionSummary(sdk);
  completeCompaction(
    state,
    out,
    "completed",
    summary === undefined ? boundary : { ...boundary, summary: truncateMessage(summary) },
  );
};

/**
 * Handles a `status` message: starts or fails the compaction as listed at
 * `RunningCompaction`. A `null` status that carries a `permissionMode` is a
 * permission-mode update, not an ending. Every other status is dropped: the
 * session's status comes from its turns.
 */
const trackCompactionStatus = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { subtype: "status" }>,
  out: Emit,
): void => {
  if (sdk.status === "compacting") {
    if (state.compaction === undefined) startCompaction(state, out, {});
  } else if (sdk.compact_result === "failed") {
    completeCompaction(state, out, "failed");
  } else if (
    sdk.status === null &&
    sdk.compact_result === undefined &&
    sdk.permissionMode === undefined &&
    state.compaction?.boundary === undefined
  ) {
    completeCompaction(state, out, "failed");
  }
};

/** Returns the count when the harness gave a number, and `undefined` otherwise. */
const readTokenCount = (value: unknown): number | undefined =>
  typeof value === "number" ? clampCount(value) : undefined;

/**
 * Handles `compact_boundary`: records the trigger and the token counts the
 * item will complete with (see `RunningCompaction`). A message with no
 * `compact_metadata` fails here, before anything changes, and `normalizeFrame`
 * reports it as an unknown message.
 */
const recordCompactBoundary = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { subtype: "compact_boundary" }>,
  out: Emit,
): void => {
  const metadata = sdk.compact_metadata;
  const trigger =
    metadata.trigger === "auto" || metadata.trigger === "manual" ? metadata.trigger : undefined;
  const tokensBefore = readTokenCount(metadata.pre_tokens);
  const tokensAfter = readTokenCount(metadata.post_tokens);
  const boundary: ContextCompactionDetail = {
    ...(trigger === undefined ? {} : { trigger }),
    ...(tokensBefore === undefined ? {} : { tokensBefore }),
    ...(tokensAfter === undefined ? {} : { tokensAfter }),
  };
  const compaction = state.compaction ?? startCompaction(state, out, boundary);
  compaction.boundary = boundary;
};

/**
 * Returns whether a rate limit stops the session: the limit is `rejected` and
 * overage does not cover it. Overage covers it when it is allowed or in use.
 */
const isUsageLimitBlocked = (
  info: Extract<SDKMessage, { type: "rate_limit_event" }>["rate_limit_info"],
): boolean =>
  info.status === "rejected" &&
  info.overageStatus !== "allowed" &&
  info.overageStatus !== "allowed_warning" &&
  info.isUsingOverage !== true &&
  info.overageInUse !== true;

/**
 * Formats a Unix time in seconds as a UTC instant such as `2026-10-28 14:00
 * UTC`. Returns `undefined` when the value is not a time `Date` can show.
 */
const formatResetTime = (seconds: unknown): string | undefined => {
  if (typeof seconds !== "number") return undefined;
  const at = new Date(seconds * 1000);
  return Number.isNaN(at.getTime())
    ? undefined
    : `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

/**
 * Handles `rate_limit_event`: warns only when the limit becomes blocked.
 * Claude repeats a blocked limit in later events, and those add nothing until
 * an event that is not blocked resets it. Every other rate limit update is
 * dropped. `resetsAt` is in seconds (measured on the real CLI), and the clause
 * is left out when the message gives none.
 */
const emitUsageLimitWarning = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { type: "rate_limit_event" }>,
  out: Emit,
): void => {
  const info = sdk.rate_limit_info;
  const blocked = isUsageLimitBlocked(info);
  const becameBlocked = blocked && !state.usageLimitBlocked;
  state.usageLimitBlocked = blocked;
  if (!becameBlocked) return;
  const resetsAt = formatResetTime(info.resetsAt);
  emitRuntimeEvent(
    state,
    out,
    "runtime.warning",
    resetsAt === undefined ? "Usage limit reached" : `Usage limit reached, resets at ${resetsAt}`,
  );
};

/**
 * Handles `local_command_output`: the output of a slash command Claude ran
 * itself, shown as an assistant message in the agent's turn.
 */
const emitLocalCommandOutput = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { subtype: "local_command_output" }>,
  out: Emit,
  agent: TurnOwner,
): void => {
  const text = truncateMessage(requireText(sdk.content, "local_command_output content"));
  if (text === "") return;
  const turn = ensureAgentTurn(state, agent, out);
  out.push(
    ...buildWholeItem(state, turn, state.mint(), "assistant_message", "assistant_text", text),
  );
};

/** Handles `memory_recall`: a notice that counts the memories Claude brought into the turn. */
const emitMemoryRecallNotice = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { subtype: "memory_recall" }>,
  out: Emit,
): void => {
  // A string has a length too, and would read as "Recalled 57 memories".
  if (!Array.isArray(sdk.memories)) throw new Error("memory_recall memories is not a list");
  const count = sdk.memories.length;
  if (count === 0) return;
  emitRuntimeEvent(
    state,
    out,
    "runtime.notice",
    count === 1 ? "Recalled 1 memory" : `Recalled ${count} memories`,
  );
};

/** Handles `api_retry`: a warning that names the error and the attempt. */
const emitRetryWarning = (
  state: Normalizing,
  sdk: Extract<SDKMessage, { subtype: "api_retry" }>,
  out: Emit,
): void => {
  emitRuntimeEvent(
    state,
    out,
    "runtime.warning",
    `retrying after ${sdk.error}: attempt ${sdk.attempt} of ${sdk.max_retries}`,
  );
};

/**
 * The message types that are model output: a turn opened for one of them stays
 * open until the `result` that ends it.
 */
const MODEL_OUTPUT_TYPES: ReadonlySet<string> = new Set(["assistant", "stream_event", "result"]);

/**
 * Checks whether a message is self-contained: the turn it opens is closed after
 * that same message. Claude sends informational messages after the `result`
 * that closed the last turn, and a turn opened for one of them would wait for
 * a `result` that never comes, so the session would look busy for good (spec
 * 06 section 6.2, synthetic turns). Every message that is not model output is
 * self-contained, including one of a type this build does not know, which
 * becomes an `unknown` item. A message of model output that could not be read
 * also becomes an `unknown` item, and `normalizeFrame` closes its turn after
 * that item as well.
 *
 * The same holds for a subagent that woke by itself: a turn its `user` or
 * `system` message opens is closed after that message.
 */
const isSelfContained = (sdk: SDKMessage): boolean => !MODEL_OUTPUT_TYPES.has(sdk.type);

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
 * `unknown` item with a label, because the CLI ships weekly and a `TypeError`
 * here would take a live session down.
 */
export const normalize = (state: Normalizing, sdk: SDKMessage): ReadonlyArray<ProviderEvent> => {
  const out = normalizeFrame(state, sdk);
  if (isSubagentStart(sdk)) out.push(...releaseHeldFrames(state));
  return out;
};

/** Returns the agent a frame belongs to, or `"unknown"` for a subagent not known yet. */
const findTurnOwner = (state: Normalizing, sdk: SDKMessage): TurnOwner | "unknown" => {
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
  // Only a conversation message of the session's own agent advances its
  // compaction: a subagent's frame, or a notice, between the boundary and the
  // summary must not take the summary's place.
  if (agent === undefined) completeCompactionAfterBoundary(state, sdk, out);
  // `out[0, ownOutputStart)` is the preserved prefix: events emitted before this
  // message is dispatched (the subagent introduction, a compaction it
  // completes). They are kept when dispatch fails and never get the raw
  // payload. `out[ownOutputStart..]` is this message's own output.
  const ownOutputStart = out.length;
  const unsolicited =
    agent === undefined ? state.turnId === undefined : agent.turn.phase === "idle";
  let fellBack = false;
  try {
    dispatch(state, sdk, agent, out);
  } catch (error) {
    // Keep what changed the state of the session or a subagent, so a turn
    // opened before the failure is still reported as started, and drop the
    // rest of this message's partial output.
    const kept = out
      .splice(ownOutputStart)
      .filter((event) => event._tag === "subagent.started" || isTurnOpeningEvent(event));
    out.push(...kept);
    emitUnknownItem(state, agent, out, sdk, error);
    fellBack = true;
  }
  if (unsolicited) {
    closeUnsolicitedTurn(state, agent, out, ownOutputStart, fellBack || isSelfContained(sdk));
  }
  // There are thousands of deltas. A copy of the message on each one would
  // double the stream, and each delta already carries its text. A delta that
  // fell back to an unknown item has no text to carry, so it keeps its raw
  // payload.
  if (sdk.type === "stream_event" && !fellBack) return out;
  const at = out.findIndex((event, index) => index >= ownOutputStart && !isTurnOpeningEvent(event));
  const found = out[at];
  if (found !== undefined) {
    out[at] = { ...found, raw: { source: CLAUDE_SDK_MESSAGE, payload: toJson(sdk) } };
  }
  return out;
};

/**
 * Ends a turn that a message opened outside any turn, when nothing else will
 * end it (spec 06 section 6.2, synthetic turns). `out` holds the events of the
 * message from index `ownOutputStart`, and `endsWithMessage` says the message is
 * complete in itself: it is not model output (`isSelfContained`), or it became
 * an `unknown` item whatever its type.
 *
 * - a turn of the session's own agent that holds a running compaction stays
 *   open: the compaction closes it when it completes;
 * - a turn of the session's own agent in which the message produced nothing
 *   is dropped, as if it was never opened, unless the message called a todo
 *   tool: that call shows nothing yet, but its result will publish the list
 *   into this turn;
 * - a turn of a subagent the harness reported stopped is closed as
 *   `interrupted` after any message it still sends, other than a stream
 *   event, which is ignored. After a stop, the stopped call's
 *   `tool_result` arrives after the `task_notification` that closed the
 *   subagent's turn, and nothing else would ever close a turn it opened;
 * - a turn opened by a message that `endsWithMessage` is closed after it.
 */
const closeUnsolicitedTurn = (
  state: Normalizing,
  agent: TurnOwner,
  out: Emit,
  ownOutputStart: number,
  endsWithMessage: boolean,
): void => {
  if (agent === undefined) {
    if (state.turnId === undefined) return;
    if (state.compaction?.turnId === state.turnId) return;
    const producedNothing = out
      .slice(ownOutputStart)
      .every((event) => event._tag === "turn.started");
    const todo = state.todos.get(buildStreamKey(undefined));
    if (producedNothing && !(todo !== undefined && hasPendingTodoCall(todo.list, state.turnId))) {
      out.length = ownOutputStart;
      state.turnId = undefined;
    } else if (endsWithMessage) {
      closeTurn(state, out, undefined, state.turnId, "completed");
    }
    return;
  }
  if (agent.turn.phase !== "open") return;
  if (agent.stop === "stopped") {
    closeTurn(state, out, agent, agent.turn.turnId, "interrupted");
  } else if (endsWithMessage) {
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
    buildRuntimeEvent(
      state,
      "runtime.warning",
      `dropped ${dropped.length} messages from a subagent the harness never reported starting`,
    ),
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

/** The `subtype` of every `system` message in the pinned SDK. */
type ClaudeSystemSubtype = Extract<SDKMessage, { type: "system" }>["subtype"];

/**
 * The name of every message in the pinned SDK: its `type`, or
 * `system/<subtype>` for a `system` message. Derived from the SDK's own types,
 * so an upgrade that adds a type or a subtype changes this type and fails
 * `CLAUDE_MESSAGE_DECISIONS` until someone decides it.
 */
type ClaudeMessageKey = Exclude<SDKMessage["type"], "system"> | `system/${ClaudeSystemSubtype}`;

/** The SDK message a key names. */
type ClaudeMessageFor<Key extends ClaudeMessageKey> = Key extends `system/${infer Subtype}`
  ? Extract<SDKMessage, { type: "system"; subtype: Subtype }>
  : Extract<SDKMessage, { type: Key }>;

/**
 * What the adapter does with one kind of Claude message: a function that adds
 * its events to `out`, or a string with the reason nothing is shown (the
 * message is dropped). `agent` is the agent the message belongs to; most
 * handlers do not read it.
 */
type ClaudeMessageDecision<Key extends ClaudeMessageKey> =
  | ((state: Normalizing, message: ClaudeMessageFor<Key>, out: Emit, agent: TurnOwner) => void)
  | string;

/**
 * The decision for every Claude message (spec 06 section 6.7). Each entry is
 * checked against the message it names: a handler takes that message's type,
 * and a key the SDK does not list is an error. A message type this build
 * does not know is not here, and `dispatch` turns it into a labelled `unknown`
 * item.
 */
const CLAUDE_MESSAGE_DECISIONS = {
  assistant: onAssistant,
  user: onUser,
  stream_event: onStreamEvent,
  result: onResult,
  "system/status": trackCompactionStatus,
  "system/compact_boundary": recordCompactBoundary,
  "system/informational": (state, message, out) =>
    emitRuntimeEvent(
      state,
      out,
      "runtime.notice",
      requireText(message.content, "informational content"),
    ),
  "system/model_refusal_fallback": (state, message, out) =>
    emitRuntimeEvent(
      state,
      out,
      "runtime.notice",
      requireText(message.content, "model_refusal_fallback content"),
    ),
  "system/notification": (state, message, out) =>
    emitRuntimeEvent(state, out, "runtime.notice", requireText(message.text, "notification text")),
  "system/memory_recall": emitMemoryRecallNotice,
  conversation_reset: (state, _message, out) =>
    emitRuntimeEvent(state, out, "runtime.notice", "Conversation was cleared"),
  "system/model_refusal_no_fallback": (state, message, out) =>
    emitRuntimeEvent(
      state,
      out,
      "runtime.warning",
      requireText(message.content, "model_refusal_no_fallback content"),
    ),
  "system/api_retry": emitRetryWarning,
  rate_limit_event: emitUsageLimitWarning,
  "system/local_command_output": emitLocalCommandOutput,
  // `task_started` and `task_notification` are a subagent's turn boundaries.
  // For every other task they do nothing, because a task's command already
  // shows as its tool item.
  "system/task_started": onTaskStarted,
  "system/task_notification": onTaskNotification,
  "system/init": "the adapter emits `session.started` itself when it starts the session",
  "system/permission_denied":
    "the denied tool item already ends failed when its `tool_result` arrives",
  "system/mirror_error": "the adapter uses no SessionStore",
  "system/hook_started": "hooks are not shown",
  "system/hook_progress": "hooks are not shown",
  "system/hook_response": "hooks are not shown",
  // The lifecycle of a task is not model work. When a background task
  // finishes, the model's answer arrives as ordinary `assistant` messages and
  // a `result`, which open and close a real turn. Kept, each of these became an
  // empty synthetic turn.
  "system/task_progress": "a task's command already shows as its tool item",
  "system/task_updated": "a task's command already shows as its tool item",
  "system/background_tasks_changed": "a task's command already shows as its tool item",
  "system/plugin_install": "plugin installation is not session output",
  "system/control_request_progress": "progress of a control request is not session output",
  "system/worker_shutting_down": "`session.exited` reports the shutdown",
  "system/elicitation_complete": "it only confirms an MCP elicitation that is already over",
  "system/thinking_tokens": "it holds a token count, not output",
  "system/session_state_changed": "the session's status comes from its turns",
  "system/commands_changed": "the slash command list is not session output",
  "system/files_persisted": "file persistence is not shown",
  tool_progress: "progress ticks of a running tool hold nothing to read",
  tool_use_summary: "the tool items already show what the tools did",
  prompt_suggestion: "a suggested next prompt is not session output",
  auth_status: "login state belongs in the capability snapshot",
} satisfies { readonly [Key in ClaudeMessageKey]: ClaudeMessageDecision<Key> };

/**
 * `CLAUDE_MESSAGE_DECISIONS` read by a key from a message, which can be
 * anything at runtime. The one cast in the table: TypeScript cannot relate a
 * key read at runtime to the handler type of that key, so every entry is read
 * as a handler of any SDK message. `satisfies` has already checked each entry
 * against its own message type.
 */
const DECISIONS_BY_KEY = CLAUDE_MESSAGE_DECISIONS as Readonly<
  Record<string, ClaudeMessageDecision<ClaudeMessageKey>>
>;

/**
 * Runs the decision for a message. A message with no entry in the table, such
 * as a type a newer `claude` binary added, becomes a labelled `unknown` item.
 * A handler that throws because a field is not what the SDK promises is turned
 * into the same item by `normalizeFrame`.
 */
const dispatch = (state: Normalizing, sdk: SDKMessage, agent: TurnOwner, out: Emit): void => {
  const key = buildClaudeMessageKey(sdk);
  const decision = Object.hasOwn(DECISIONS_BY_KEY, key) ? DECISIONS_BY_KEY[key] : undefined;
  if (decision === undefined) {
    emitUnknownItem(state, agent, out, sdk);
    return;
  }
  if (typeof decision === "function") decision(state, sdk, out, agent);
};

/** The `type` of every content block an assistant message can hold in the pinned SDK. */
type AssistantBlockType = AssistantBlock["type"];

/**
 * What the adapter does with one type of content block: a function that adds
 * its events to `scope.out`, or a string with the reason nothing is shown (the
 * block is dropped).
 */
type BlockDecision<Type extends AssistantBlockType> =
  | ((block: AssistantBlockFor<Type>, scope: BlockScope) => void)
  | string;

/**
 * The decision for every content block of an assistant message (spec 06
 * section 6.7). Like `CLAUDE_MESSAGE_DECISIONS`, it is checked when the code is
 * compiled: a block type the pinned SDK lists and this table lacks is an error,
 * so an SDK upgrade that adds a block type fails typecheck until someone
 * decides it. A block type this build does not know is not here, and
 * `handleBlock` turns it into a labelled `unknown` item.
 */
const CLAUDE_BLOCK_DECISIONS = {
  text: emitAssistantText,
  thinking: emitAssistantThinking,
  tool_use: startLocalTool,
  server_tool_use: startServerTool,
  mcp_tool_use: startMcpTool,
  web_search_tool_result: buildResultHandler(ORPHAN_WEB_SEARCH, convertWebSearchResult),
  web_fetch_tool_result: buildResultHandler(buildOrphanWebFetch, convertWebFetchResult),
  mcp_tool_result: buildResultHandler(ORPHAN_MCP_TOOL, convertMcpResult),
  code_execution_tool_result: buildResultHandler(ORPHAN_NATIVE_TOOL, convertCodeExecutionResult),
  bash_code_execution_tool_result: buildResultHandler(
    ORPHAN_NATIVE_TOOL,
    convertBashCodeExecutionResult,
  ),
  text_editor_code_execution_tool_result: buildResultHandler(
    ORPHAN_NATIVE_TOOL,
    convertTextEditorResult,
  ),
  advisor_tool_result: buildResultHandler(ORPHAN_NATIVE_TOOL, convertAdvisorResult),
  tool_search_tool_result: buildResultHandler(ORPHAN_NATIVE_TOOL, convertToolSearchResult),
  redacted_thinking: "nothing readable",
  compaction: "the compact_boundary system message already draws the compaction row",
  // A file the model uploaded to its container, and a switch to another model
  // after a refusal. Neither has an item kind, but the user should see that
  // something happened.
  container_upload: (block, scope) => emitUnknownBlock(scope, block),
  fallback: (block, scope) => emitUnknownBlock(scope, block),
} satisfies { readonly [Type in AssistantBlockType]: BlockDecision<Type> };

/**
 * `CLAUDE_BLOCK_DECISIONS` read by a type from a block, which can be anything
 * at runtime. The one cast in the table, for the same reason as
 * `DECISIONS_BY_KEY`: every entry is read as a handler of any block, and
 * `satisfies` has already checked each entry against its own block type.
 */
const DECISIONS_BY_BLOCK_TYPE = CLAUDE_BLOCK_DECISIONS as Readonly<
  Record<string, BlockDecision<AssistantBlockType>>
>;
