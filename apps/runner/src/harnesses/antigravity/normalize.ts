/**
 * Converts the ACP messages of an Antigravity session into normalized harness
 * events. The input is one message and a small mutable state per session; the
 * output is a list of events. Nothing here touches a process or a socket. Spec
 * 06 sections 6.2 (turns), 6.3 (items), 6.6 (usage) and 6.7 (the decision for
 * every message) own the rules.
 *
 * ACP has no turn, no item ids for text, and no todo list, so this module
 * supplies them:
 *
 * - A turn is opened and closed by the adapter (`openTurn`, `closeTurn`). Output
 *   that arrives with no turn open gets a synthetic turn, which closes when
 *   its last item completes.
 * - A text item starts at its first chunk and completes at the next message of
 *   another kind, at `usage_update`, or when the turn closes.
 * - The `todo_list` and `plan` items are rebuilt from the files the model
 *   writes, because `agy` sends no ACP `plan` update.
 *
 * This module emits no `user_message`, `session.started`, `session.exited` or
 * `request.*` event: the session and the adapter own those.
 */
import { resolve } from "node:path";
import type {
  SessionUpdate,
  SessionUpdateNotification,
  ToolCall,
  UnhandledMessage,
  Usage as PromptUsage,
} from "@hercule/acp";
import {
  MAX_TODO_STEPS,
  type HarnessEvent,
  type ItemKind,
  type ItemStatus,
  type StreamKind,
  type TodoStep,
  type TurnState,
  type Usage,
} from "@hercule/protocol";
import type * as Schema from "effect/Schema";
import { ensureId } from "../events";
import { buildEnvelope, buildRaw, clampCount } from "../normalize";
import { buildUnknownItemLabel } from "../message-reporting";
import { truncateFact, truncateMessage } from "../text";
import {
  buildApprovalDescription,
  buildToolItem,
  type ApprovalDescription,
  type ToolCallFields,
} from "./tool-items";

/** The channel name every raw payload from this adapter is reported under. */
const ANTIGRAVITY_MESSAGE = "antigravity.acp.message";

/** The prefix of the label of an `unknown` item built from an Antigravity message. */
const LABEL_PREFIX = "antigravity";

/** The token counts of one scope (a turn, or the whole process), added up. */
interface Totals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** The agent's todo list in a turn: its item, and the list the item last showed. */
interface TodoRecord {
  readonly itemId: string;
  readonly steps: ReadonlyArray<TodoStep>;
}

/** A turn that is open: the user's, or a synthetic one for output that has no input. */
interface TurnRecord {
  readonly id: string;
  readonly synthetic: boolean;
  /**
   * The ids of this turn's items that have started and not completed. A
   * synthetic turn closes when this is empty, because nothing else would close
   * it.
   */
  readonly running: Set<string>;
  todo: TodoRecord | undefined;
  /** The usage of the prompts of this turn, added up, and whether any prompt reported usage. */
  readonly usage: Totals;
  hasUsage: boolean;
}

/** An assistant message or a reasoning block that has started and not completed. */
interface TextRecord {
  readonly itemId: string;
  readonly kind: "assistant_message" | "reasoning";
  readonly turnId: string;
}

/** An item made from a tool call that has started and not ended. */
interface RunningTool {
  readonly itemId: string;
  /** The turn the item started in, which it completes in, also when that turn is over. */
  readonly turnId: string;
  /** The call's fields so far: an update keeps the last value of a field it leaves out. */
  call: ToolCallFields;
  readonly ended: false;
}

/**
 * What stays of a tool item after it ends: nothing but the fact that it ended,
 * so a long session does not hold every file it edited. It is enough to ignore
 * a late update.
 */
interface EndedTool {
  readonly ended: true;
}

const ENDED_TOOL: EndedTool = { ended: true };

type ToolRecord = RunningTool | EndedTool;

/** A message that arrived while a turn was held, to be handled when the turn opens or is released. */
type BufferedMessage =
  | { readonly type: "update"; readonly notification: SessionUpdateNotification }
  | { readonly type: "unhandled"; readonly message: UnhandledMessage };

/**
 * The state of one session's normalizing. Build it with `buildNormalizingState`.
 * Nothing outside this module reads its fields.
 */
export interface Normalizing {
  readonly sessionId: string;
  readonly nativeSessionId: string;
  /** The folder `<Harness Home>/antigravity-acp/brain`, where the model keeps its plan files. */
  readonly brainFolder: string;
  /** The turn in flight, if any. */
  turn: TurnRecord | undefined;
  /** Whether an input is being prepared: no synthetic turn opens while it is. */
  held: boolean;
  /** What arrived while `held` and no turn was open, in order. */
  readonly buffered: Array<BufferedMessage>;
  /** The open assistant message or reasoning block, if any. */
  text: TextRecord | undefined;
  /** Every tool call seen, by `toolCallId`. */
  readonly tools: Map<string, ToolRecord>;
  /** The calls whose Request the adapter answered with a deny or a cancel. */
  readonly declined: Set<string>;
  readonly processUsage: Totals;
  /**
   * Whether the process used tokens that no prompt reply counts: a subagent
   * ran, output came with no prompt open, or a reply had no usage.
   */
  usageIsIncomplete: boolean;
}

/** The turn and item a Request belongs to. */
export interface RequestOwner {
  readonly turnId: string;
  readonly itemId: string;
}

/** The part of an approval Request that comes from its item: its owner and what the call is. */
export interface RequestItem extends RequestOwner {
  readonly description: ApprovalDescription;
}

/**
 * Returns the state for a new session. `brainFolder` is
 * `<Harness Home>/antigravity-acp/brain`: this session's plan files are in
 * `<brainFolder>/<nativeSessionId>/`.
 */
export const buildNormalizingState = (input: {
  readonly sessionId: string;
  readonly nativeSessionId: string;
  readonly brainFolder: string;
}): Normalizing => ({
  sessionId: input.sessionId,
  nativeSessionId: input.nativeSessionId,
  brainFolder: input.brainFolder,
  turn: undefined,
  held: false,
  buffered: [],
  text: undefined,
  tools: new Map(),
  declined: new Set(),
  processUsage: buildZeroTotals(),
  usageIsIncomplete: false,
});

const buildZeroTotals = (): Totals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

// ---- Event builders ----

/** Returns the fields every event has. The call's id goes in `harnessRefs` for an event about a call. */
const buildBase = (state: Normalizing, toolCallId?: string) =>
  buildEnvelope(state.sessionId, {
    nativeSessionId: state.nativeSessionId,
    ...(toolCallId === undefined ? {} : { toolCallId }),
  });

/** Returns the `raw` field for an event built from `message`, or nothing when there is none. */
const buildMessageRaw = (message: { readonly raw: unknown } | undefined) =>
  message === undefined ? {} : buildRaw(ANTIGRAVITY_MESSAGE, message.raw);

/** The fields that say which item an item event is about. */
interface ItemFields {
  readonly turnId: string;
  readonly itemId: string;
  readonly kind: ItemKind;
  readonly detail?: Schema.Json | undefined;
  /** The `toolCallId`, for an item made from a tool call. */
  readonly toolCallId?: string;
}

const buildItemStarted = (
  state: Normalizing,
  item: ItemFields,
  message?: { readonly raw: unknown },
): HarnessEvent => ({
  _tag: "item.started",
  ...buildBase(state, item.toolCallId),
  ...buildMessageRaw(message),
  turnId: item.turnId,
  itemId: item.itemId,
  kind: item.kind,
  ...(item.detail === undefined ? {} : { detail: item.detail }),
});

const buildItemUpdated = (state: Normalizing, item: ItemFields): HarnessEvent => ({
  _tag: "item.updated",
  ...buildBase(state, item.toolCallId),
  turnId: item.turnId,
  itemId: item.itemId,
  kind: item.kind,
  ...(item.detail === undefined ? {} : { detail: item.detail }),
});

const buildItemCompleted = (
  state: Normalizing,
  item: ItemFields,
  status: ItemStatus,
  message?: { readonly raw: unknown },
): HarnessEvent => ({
  _tag: "item.completed",
  ...buildBase(state, item.toolCallId),
  ...buildMessageRaw(message),
  turnId: item.turnId,
  itemId: item.itemId,
  kind: item.kind,
  status,
  ...(item.detail === undefined ? {} : { detail: item.detail }),
});

const buildTurnStarted = (state: Normalizing, turnId: string): HarnessEvent => ({
  _tag: "turn.started",
  ...buildBase(state),
  turnId,
});

const buildRuntimeWarning = (
  state: Normalizing,
  turnId: string,
  message: string,
): HarnessEvent => ({
  _tag: "runtime.warning",
  ...buildBase(state),
  turnId,
  message: truncateMessage(message),
});

const buildUsage = (totals: Totals): Usage => ({
  inputTokens: totals.inputTokens,
  outputTokens: totals.outputTokens,
  cacheReadTokens: totals.cacheReadTokens,
  cacheWriteTokens: totals.cacheWriteTokens,
});

// ---- Turns ----

const buildTurnRecord = (id: string, synthetic: boolean): TurnRecord => ({
  id,
  synthetic,
  running: new Set(),
  todo: undefined,
  usage: buildZeroTotals(),
  hasUsage: false,
});

/**
 * Returns the turn an item that starts now belongs to, and the events that
 * open it. With no turn open, this opens a synthetic turn, and marks usage
 * incomplete because the model's tokens for that output are in no prompt
 * reply. The caller has checked that no input is held, so the turn is never
 * opened while the adapter prepares one.
 */
const ensureTurn = (
  state: Normalizing,
): { readonly turn: TurnRecord; readonly events: HarnessEvent[] } => {
  if (state.turn !== undefined) return { turn: state.turn, events: [] };
  const turn = buildTurnRecord(crypto.randomUUID(), true);
  state.turn = turn;
  const events = [buildTurnStarted(state, turn.id)];
  if (!state.usageIsIncomplete) {
    state.usageIsIncomplete = true;
    events.push(buildUsageUpdated(state));
  }
  return { turn, events };
};

/**
 * Returns the events that end the turn in flight, or nothing when none is open:
 * the open text item completes, the turn's todo list completes with the list it
 * last showed, then `turn.completed` carries `end.state`, `end.error` (the text
 * of a failure) and the sum of the usage of the turn's prompts
 * (`addPromptUsage`). Items still running stay running: their late updates
 * complete them in this turn. When `end.turnId` is set, only the turn with
 * that id is closed: a caller that waited before closing must not close
 * a newer turn that opened meanwhile.
 */
export const closeTurn = (
  state: Normalizing,
  end: { readonly state: TurnState; readonly error?: string; readonly turnId?: string },
): HarnessEvent[] => {
  const turn = state.turn;
  if (turn === undefined || (end.turnId !== undefined && end.turnId !== turn.id)) return [];
  const events = closeTextItem(state);
  if (turn.todo !== undefined) {
    events.push(
      buildItemCompleted(
        state,
        {
          turnId: turn.id,
          itemId: turn.todo.itemId,
          kind: "todo_list",
          detail: { steps: turn.todo.steps },
        },
        "completed",
      ),
    );
  }
  events.push({
    _tag: "turn.completed",
    ...buildBase(state),
    turnId: turn.id,
    state: end.state,
    ...(turn.hasUsage ? { usage: buildUsage(turn.usage) } : {}),
    ...(end.error === undefined || end.error === "" ? {} : { error: truncateMessage(end.error) }),
  });
  state.turn = undefined;
  return events;
};

/** Returns the id of the open synthetic turn (output came with no input, and no input's turn is open), or `undefined` when there is none. */
export const readSyntheticTurnId = (state: Normalizing): string | undefined =>
  state.turn?.synthetic === true ? state.turn.id : undefined;

/** Returns the events that close the synthetic turn when its last item has completed, else nothing. */
const closeIdleSyntheticTurn = (state: Normalizing): HarnessEvent[] =>
  state.turn?.synthetic === true && state.turn.running.size === 0
    ? closeTurn(state, { state: "completed" })
    : [];

/**
 * Starts holding a turn for an input that is being prepared. From now on, a
 * message that would draw something is kept in a buffer and no synthetic turn
 * opens, because the input's own turn is about to start and a second turn would
 * overlap it. An update for a call that is already known goes through, because
 * it completes an item of an earlier turn.
 */
export const holdTurn = (state: Normalizing): void => {
  state.held = true;
};

/**
 * Opens the turn of the held input and returns `turn.started`, then
 * `afterStart` (the input's `user_message`, which must come first in the turn),
 * then the events of the buffered messages, now in that turn. A synthetic turn that is
 * still open is closed first as completed, because one agent never has two turns
 * at once: its running items finish in it later.
 */
export const openTurn = (
  state: Normalizing,
  turnId: string,
  afterStart: ReadonlyArray<HarnessEvent> = [],
): HarnessEvent[] => {
  const events = closeTurn(state, { state: "completed" });
  state.held = false;
  state.turn = buildTurnRecord(turnId, false);
  events.push(buildTurnStarted(state, turnId), ...afterStart);
  return [...events, ...replayBuffered(state)];
};

/**
 * Stops holding a turn because the input was abandoned, and returns the events
 * of the buffered messages as output with no input: each opens a synthetic turn
 * as it needs one.
 */
export const releaseTurn = (state: Normalizing): HarnessEvent[] => {
  state.held = false;
  return replayBuffered(state);
};

const replayBuffered = (state: Normalizing): HarnessEvent[] =>
  state.buffered
    .splice(0)
    .flatMap((message) =>
      message.type === "update"
        ? normalizeUpdate(state, message.notification)
        : normalizeUnhandled(state, message.message),
    );

// ---- Text items ----

/** Returns the event that completes the open text item, or nothing when none is open. */
const closeTextItem = (state: Normalizing): HarnessEvent[] => {
  const text = state.text;
  if (text === undefined) return [];
  state.text = undefined;
  if (state.turn?.id === text.turnId) state.turn.running.delete(text.itemId);
  return [
    buildItemCompleted(
      state,
      { turnId: text.turnId, itemId: text.itemId, kind: text.kind },
      "completed",
    ),
  ];
};

const STREAM_KINDS = {
  assistant_message: "assistant_text",
  reasoning: "reasoning_text",
} as const satisfies Record<TextRecord["kind"], StreamKind>;

/**
 * Returns the events for a chunk of text. A chunk of the same kind as the open
 * item adds to it. Any other chunk first completes the open item, then starts a
 * new one in the turn.
 */
const appendText = (
  state: Normalizing,
  kind: TextRecord["kind"],
  text: string,
  notification: SessionUpdateNotification,
): HarnessEvent[] => {
  if (text === "") return [];
  const events = state.text?.kind === kind ? [] : closeTextItem(state);
  if (state.text === undefined) {
    const { turn, events: turnEvents } = ensureTurn(state);
    const itemId = crypto.randomUUID();
    state.text = { itemId, kind, turnId: turn.id };
    turn.running.add(itemId);
    events.push(
      ...turnEvents,
      buildItemStarted(state, { turnId: turn.id, itemId, kind }, notification),
    );
  }
  events.push({
    _tag: "content.delta",
    ...buildBase(state),
    turnId: state.text.turnId,
    itemId: state.text.itemId,
    streamKind: STREAM_KINDS[kind],
    delta: text,
  });
  return events;
};

// ---- Unknown items ----

/**
 * Returns the events for an `unknown` item labelled `antigravity: <name>`: the
 * item starts and completes at once, in the turn in flight, or in a synthetic
 * turn that the caller then closes. The open text item completes first, because
 * the message is of another kind.
 */
const buildUnknownItem = (
  state: Normalizing,
  name: string,
  message: { readonly raw: unknown },
): HarnessEvent[] => {
  const events = closeTextItem(state);
  const { turn, events: turnEvents } = ensureTurn(state);
  const item: ItemFields = {
    turnId: turn.id,
    itemId: crypto.randomUUID(),
    kind: "unknown",
    detail: { label: buildUnknownItemLabel(LABEL_PREFIX, name) },
  };
  events.push(
    ...turnEvents,
    buildItemStarted(state, item, message),
    buildItemCompleted(state, item, "completed"),
  );
  return events;
};

// ---- Decisions for every sessionUpdate ----

/** Every `sessionUpdate` value that `agy` 1.5.15 sends, and `plan` from the ACP schema. */
const UPDATE_NAMES = [
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "usage_update",
  "available_commands_update",
  "session_info_update",
  "current_mode_update",
  "config_option_update",
  "user_message_chunk",
  "plan",
] as const;

type UpdateName = (typeof UPDATE_NAMES)[number];

/** What to do with a `sessionUpdate`. */
type UpdateDecision =
  | "message"
  | "thought"
  | "toolStart"
  | "toolUpdate"
  /** Complete the open text item, then drop the update. */
  | "closeText"
  | "drop"
  | "unknown";

/**
 * The decision for each name, typed over the list above: adding a name to the
 * list fails typecheck until it is decided here. A name not in the list, which a
 * newer `agy` can send, is an `unknown` item.
 */
const UPDATE_DECISIONS: Readonly<Record<UpdateName, UpdateDecision>> = {
  agent_message_chunk: "message",
  agent_thought_chunk: "thought",
  tool_call: "toolStart",
  tool_call_update: "toolUpdate",
  usage_update: "closeText",
  // Hercule offers none of the slash commands, names its own Threads, and reads
  // the mode and the model from the session's settings.
  available_commands_update: "drop",
  session_info_update: "drop",
  current_mode_update: "drop",
  config_option_update: "drop",
  // The input is already shown as a `user_message`.
  user_message_chunk: "drop",
  // No recording shows `agy` sending it, so it is shown as unknown until it is seen.
  plan: "unknown",
};

const readUpdateName = (update: SessionUpdate): string =>
  update.sessionUpdate === "other" ? update.name : update.sessionUpdate;

const isKnownUpdateName = (name: string): name is UpdateName =>
  (UPDATE_NAMES as ReadonlyArray<string>).includes(name);

const decideUpdate = (name: string): UpdateDecision =>
  isKnownUpdateName(name) ? UPDATE_DECISIONS[name] : "unknown";

/** Returns the text of a message or thought chunk, or `undefined` when the chunk holds anything else. */
const readChunkText = (update: SessionUpdate): string | undefined =>
  (update.sessionUpdate === "agent_message_chunk" ||
    update.sessionUpdate === "agent_thought_chunk") &&
  update.content.type === "text" &&
  typeof update.content.text === "string"
    ? update.content.text
    : undefined;

/** Returns the tool call an update carries, or `undefined` when the update is of another kind. */
const readToolCall = (update: SessionUpdate): ToolCall | undefined =>
  update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update"
    ? update
    : undefined;

// ---- Tool items ----

const mergeCall = (last: ToolCallFields, next: ToolCallFields): ToolCallFields => ({
  toolCallId: last.toolCallId,
  name: next.name ?? last.name,
  title: next.title ?? last.title,
  kind: next.kind ?? last.kind,
  status: next.status ?? last.status,
  content: next.content ?? last.content,
  rawInput: next.rawInput ?? last.rawInput,
  rawOutput: next.rawOutput ?? last.rawOutput,
});

/**
 * Returns the events for a `tool_call` (`isStart`) or a `tool_call_update`.
 *
 * - The first message of a call starts its item, in the turn in flight or a
 *   synthetic one. An update for a call never seen starts an item only when it
 *   has the name and the input; a status note starts nothing.
 * - A message never starts the item a second time, and never reopens an item
 *   that ended. A field it leaves out keeps its last value.
 * - Only a message that carries `rawInput` can end the item: `completed`
 *   completes it, `failed` fails it, or declines it when the adapter answered
 *   its Request with a deny or a cancel. Any other status is not an end.
 */
const normalizeToolCall = (
  state: Normalizing,
  notification: SessionUpdateNotification,
  call: ToolCall,
  isStart: boolean,
): HarnessEvent[] => {
  let record = state.tools.get(call.toolCallId);
  // A late update of an ended call changes nothing, so it must not close the
  // open message either: that would split one message in two.
  if (record?.ended === true) return [];
  const events = closeTextItem(state);
  if (record === undefined) {
    if (!isStart && (call.rawInput == null || !call.name)) return events;
    const { turn, events: turnEvents } = ensureTurn(state);
    const started: RunningTool = {
      itemId: ensureId(call.toolCallId),
      turnId: turn.id,
      call: mergeCall({ toolCallId: call.toolCallId }, call),
      ended: false,
    };
    record = started;
    state.tools.set(call.toolCallId, record);
    turn.running.add(record.itemId);
    const { kind, detail } = buildToolItem(record.call);
    if (kind === "subagent") state.usageIsIncomplete = true;
    events.push(
      ...turnEvents,
      buildItemStarted(
        state,
        { turnId: record.turnId, itemId: record.itemId, kind, detail, toolCallId: call.toolCallId },
        notification,
      ),
    );
  } else {
    record.call = mergeCall(record.call, call);
  }
  if (record.ended || call.rawInput == null) return events;
  const running = record;
  if (call.status !== "completed" && call.status !== "failed") return events;

  const wasDeclined = state.declined.delete(call.toolCallId);
  const status: ItemStatus =
    call.status === "completed" ? "completed" : wasDeclined ? "declined" : "failed";
  state.tools.set(call.toolCallId, ENDED_TOOL);
  if (state.turn?.id === record.turnId) state.turn.running.delete(record.itemId);
  const { kind, detail } = buildToolItem(running.call);
  events.push(
    buildItemCompleted(
      state,
      { turnId: record.turnId, itemId: record.itemId, kind, detail, toolCallId: call.toolCallId },
      status,
      notification,
    ),
  );
  if (status === "completed" && kind === "file_change") {
    events.push(...buildPlanFileEvents(state, running, call));
  }
  return events;
};

// ---- todo_list and plan, rebuilt from the model's files ----

const TASK_FILE = "task.md";
const PLAN_FILE = "implementation_plan.md";

/**
 * Returns the other spelling of `path`, but only on macOS, where `/tmp`, `/var` and
 * `/etc` are links to `/private/tmp`, `/private/var` and `/private/etc`. `agy`
 * reports the same file under either spelling.
 */
const toOtherMacSpelling = (path: string): string => {
  if (process.platform !== "darwin") return path;
  if (/^\/private\/(tmp|var|etc)(\/|$)/.test(path)) return path.slice("/private".length);
  return /^\/(tmp|var|etc)(\/|$)/.test(path) ? `/private${path}` : path;
};

/** Checks that `given` and `expected` name the same file: equal after `resolve`, or equal but for the `/private` spelling. */
const isSameFile = (given: string, expected: string): boolean => {
  const actual = resolve(given);
  const wanted = resolve(expected);
  return actual === wanted || actual === toOtherMacSpelling(wanted);
};

/** Returns the text a completed update says the file now holds: the `newText` of its first diff. */
const readWrittenText = (call: ToolCallFields): string | undefined => {
  for (const entry of call.content ?? []) {
    if (entry.type === "diff" && typeof entry.newText === "string") return entry.newText;
  }
  return undefined;
};

/**
 * Returns the steps of a `task.md`. A line `- [ ]` is `pending`, `- [/]` is
 * `in_progress` and `- [x]` is `completed`. A step with no text is left out, as
 * is every other line.
 */
const parseTaskSteps = (text: string): TodoStep[] =>
  text.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*-\s+\[([ /xX])\]\s*(.*?)\s*$/.exec(line);
    if (match === null || match[2] === "") return [];
    const mark = match[1];
    const status = mark === " " ? "pending" : mark === "/" ? "in_progress" : "completed";
    return [{ text: truncateFact(match[2]!), status }];
  });

/**
 * Returns the events for a completed write of this session's `task.md` or
 * `implementation_plan.md`, which come after the write's own `file_change`
 * item. Any other write gives nothing, and so does a write whose update has no
 * diff, or whose turn is over (an item never starts in a turn that has ended).
 *
 * - `task.md` shows the one `todo_list` item of the turn: `item.started` for the
 *   first list, `item.updated` with the whole list for each change, nothing for
 *   a list that did not change. A list over `MAX_TODO_STEPS` leaves the item as
 *   it is and sends a warning, because a cut list would show a wrong count.
 * - `implementation_plan.md` shows a `plan` item holding the file's text.
 */
const buildPlanFileEvents = (
  state: Normalizing,
  record: RunningTool,
  completingCall: ToolCall,
): HarnessEvent[] => {
  const turn = state.turn;
  if (turn === undefined || turn.id !== record.turnId) return [];
  const rawInput = record.call.rawInput;
  const path =
    typeof rawInput === "object" && rawInput !== null
      ? (rawInput as Record<string, unknown>)["Path"]
      : undefined;
  const text = readWrittenText(completingCall);
  if (typeof path !== "string" || text === undefined) return [];
  const folder = `${state.brainFolder}/${state.nativeSessionId}`;

  if (isSameFile(path, `${folder}/${PLAN_FILE}`)) {
    const item: ItemFields = {
      turnId: turn.id,
      itemId: `${record.itemId}:plan`,
      kind: "plan",
    };
    return [
      buildItemStarted(state, item),
      buildItemCompleted(
        state,
        { ...item, detail: { content: truncateMessage(text) } },
        "completed",
      ),
    ];
  }
  if (!isSameFile(path, `${folder}/${TASK_FILE}`)) return [];

  const steps = parseTaskSteps(text);
  if (steps.length > MAX_TODO_STEPS) {
    return [
      buildRuntimeWarning(
        state,
        turn.id,
        `Antigravity's task list has ${String(steps.length)} steps. Hercule shows at most ${String(MAX_TODO_STEPS)}, so the list was not updated.`,
      ),
    ];
  }
  const shown = turn.todo;
  if (
    shown === undefined ? steps.length === 0 : JSON.stringify(shown.steps) === JSON.stringify(steps)
  ) {
    return [];
  }
  const itemId = shown?.itemId ?? `${turn.id}:todo`;
  turn.todo = { itemId, steps };
  const item: ItemFields = { turnId: turn.id, itemId, kind: "todo_list", detail: { steps } };
  return [shown === undefined ? buildItemStarted(state, item) : buildItemUpdated(state, item)];
};

// ---- Public: messages ----

/**
 * Returns true when `message` must wait in the buffer: an input is held, no
 * turn is open, and the message is not an update for a call that is already
 * known (that one completes an item in an earlier turn and may go through).
 */
const mustBuffer = (state: Normalizing, update?: SessionUpdate): boolean => {
  if (!state.held || state.turn !== undefined) return false;
  const call = update === undefined ? undefined : readToolCall(update);
  return call === undefined || !state.tools.has(call.toolCallId);
};

/**
 * Returns the events for one `session/update` notification. Every update
 * value has a decision (spec 06 section 6.7):
 *
 * - message and thought chunks are `assistant_message` and `reasoning` items
 *   with `content.delta`;
 * - `tool_call` and `tool_call_update` are items, by the tool's name;
 * - `usage_update` completes the open text item and is dropped;
 * - the other known updates are dropped, or not drawn when the session reads
 *   them itself;
 * - `plan`, any value this build does not know, and a chunk that holds no text
 *   are `unknown` items labelled `antigravity: <name>`.
 *
 * While a turn is held (`holdTurn`) with none open, the messages that would draw
 * something are kept, and this returns nothing for them.
 */
export const normalizeUpdate = (
  state: Normalizing,
  notification: SessionUpdateNotification,
): HarnessEvent[] => {
  if (mustBuffer(state, notification.update)) {
    state.buffered.push({ type: "update", notification });
    return [];
  }
  return [...routeUpdate(state, notification), ...closeIdleSyntheticTurn(state)];
};

const routeUpdate = (
  state: Normalizing,
  notification: SessionUpdateNotification,
): HarnessEvent[] => {
  const { update } = notification;
  const name = readUpdateName(update);
  const decision = decideUpdate(name);
  switch (decision) {
    case "message":
    case "thought": {
      const text = readChunkText(update);
      return text === undefined
        ? buildUnknownItem(state, name, notification)
        : appendText(
            state,
            decision === "message" ? "assistant_message" : "reasoning",
            text,
            notification,
          );
    }
    case "toolStart":
    case "toolUpdate": {
      const call = readToolCall(update);
      return call === undefined
        ? buildUnknownItem(state, name, notification)
        : normalizeToolCall(state, notification, call, decision === "toolStart");
    }
    case "closeText":
      return closeTextItem(state);
    case "drop":
      return [];
    case "unknown":
      return buildUnknownItem(state, name, notification);
  }
};

/**
 * Returns the events for a message the connection could not give to any other
 * handler: an `unknown` item labelled `antigravity: <method>`. Like an update
 * that draws something, it waits in the buffer while a turn is held.
 */
export const normalizeUnhandled = (
  state: Normalizing,
  message: UnhandledMessage,
): HarnessEvent[] => {
  if (mustBuffer(state)) {
    state.buffered.push({ type: "unhandled", message });
    return [];
  }
  return [...buildUnknownItem(state, message.method, message), ...closeIdleSyntheticTurn(state)];
};

// ---- Public: declined calls and approvals ----

/**
 * Records that the adapter answered the Request of this call with a deny or a
 * cancel. `agy` reports `failed` for a call refused that way, so the item's
 * `failed` is then shown as `declined`. A call whose item is unknown or has
 * ended is not recorded: no `failed` would ever remove it.
 */
export const markDeclined = (state: Normalizing, toolCallId: string): void => {
  if (state.tools.get(toolCallId)?.ended === false) state.declined.add(toolCallId);
};

/**
 * Returns the turn and item a Request is about, or `undefined` when the call's
 * item is unknown, has ended, or is in a turn that is over, because a Request
 * needs a running item in the turn in flight. The caller then cancels the
 * Request.
 */
export const findRequestOwner = (
  state: Normalizing,
  toolCallId: string,
): RequestOwner | undefined => {
  const record = state.tools.get(toolCallId);
  if (record === undefined || record.ended || record.turnId !== state.turn?.id) return undefined;
  return { turnId: record.turnId, itemId: record.itemId };
};

/**
 * Returns true when an update about the call `toolCallId` waits in the buffer
 * of a held turn. A Request about such a call is early, not orphaned: its item
 * appears when the input's turn opens.
 */
export const isCallBuffered = (state: Normalizing, toolCallId: string): boolean =>
  state.buffered.some(
    (message) =>
      message.type === "update" &&
      readToolCall(message.notification.update)?.toolCallId === toolCallId,
  );

/**
 * Returns the owner of an approval Request, as `findRequestOwner` does, with
 * the Request's kind and detail built from the call. The approval's own
 * `snapshot` of the tool call is read over the fields the item last had.
 * Returns `undefined` under the same conditions as `findRequestOwner`.
 */
export const describeRequestItem = (
  state: Normalizing,
  toolCallId: string,
  snapshot: ToolCall,
): RequestItem | undefined => {
  const owner = findRequestOwner(state, toolCallId);
  const record = state.tools.get(toolCallId);
  if (owner === undefined || record === undefined || record.ended) return undefined;
  return { ...owner, description: buildApprovalDescription(mergeCall(record.call, snapshot)) };
};

// ---- Public: usage ----

/**
 * Adds the usage of one prompt reply to the turn in flight and to the process,
 * and returns `session.usage.updated` with the process's sum. The event has
 * the incomplete form once the process used tokens that no reply counts: a
 * subagent ran, output came with no prompt open, or a reply had no usage.
 * `thoughtTokens` is never added, because `outputTokens` already includes it.
 */
export const addPromptUsage = (
  state: Normalizing,
  usage: PromptUsage | null | undefined,
): HarnessEvent[] => {
  if (usage == null) {
    state.usageIsIncomplete = true;
  } else {
    const parts: Totals = {
      inputTokens: clampCount(usage.inputTokens),
      outputTokens: clampCount(usage.outputTokens),
      cacheReadTokens: clampCount(usage.cachedReadTokens),
      cacheWriteTokens: clampCount(usage.cachedWriteTokens),
    };
    addTotals(state.processUsage, parts);
    if (state.turn !== undefined) {
      addTotals(state.turn.usage, parts);
      state.turn.hasUsage = true;
    }
  }
  return [buildUsageUpdated(state)];
};

/** Returns `session.usage.updated` with the process's sum, in the incomplete form once that applies. */
const buildUsageUpdated = (state: Normalizing): HarnessEvent => {
  const counts = buildUsage(state.processUsage);
  return {
    _tag: "session.usage.updated",
    ...buildBase(state),
    ...(state.usageIsIncomplete
      ? { usageReport: { status: "incomplete" as const, counts } }
      : { usage: counts }),
  };
};

const addTotals = (total: Totals, parts: Totals): void => {
  total.inputTokens += parts.inputTokens;
  total.outputTokens += parts.outputTokens;
  total.cacheReadTokens += parts.cacheReadTokens;
  total.cacheWriteTokens += parts.cacheWriteTokens;
};

// ---- Public: the end of the process ----

/**
 * Returns the events for the end of the `agy` process: the open text item
 * completes, every item still running fails in its own turn (its result will
 * never come), and an open synthetic turn closes as completed. A turn of the
 * user's is left to `closeTurn`.
 */
export const closeProcess = (state: Normalizing): HarnessEvent[] => {
  const events = closeTextItem(state);
  for (const [toolCallId, record] of state.tools) {
    if (record.ended) continue;
    state.tools.set(toolCallId, ENDED_TOOL);
    const { kind, detail } = buildToolItem(record.call);
    events.push(
      buildItemCompleted(
        state,
        { turnId: record.turnId, itemId: record.itemId, kind, detail, toolCallId },
        "failed",
      ),
    );
  }
  state.turn?.running.clear();
  state.declined.clear();
  state.buffered.length = 0;
  return [
    ...events,
    ...(state.turn?.synthetic === true ? closeTurn(state, { state: "completed" }) : []),
  ];
};
