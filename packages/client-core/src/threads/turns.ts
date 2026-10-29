/**
 * Groups a transcript into turns. A transcript is a flat log of provider
 * events, and a turn is what the thread screen renders. Grouping here means
 * the transcript column only renders turns, and no provider event names leak
 * into it.
 *
 * The assistant's text is never on `item.started` or `item.completed`: it
 * only arrives as `content.delta` events (spec 06 §6.3-6.4). So:
 *
 * - each user message comes from the `user_message` item's `item.started`:
 *   its text from `detail.text`, its images from `detail.attachments`, whether
 *   it was steered from `detail.steered`, and the agent that sent it from
 *   `detail.senderSessionId`;
 * - the assistant's text is the turn's `assistant_text` deltas joined in
 *   transcript order;
 * - a `runtime.error` or `runtime.warning` row becomes a runtime note, in the turn
 *   it belongs to or, when it belongs to none, between the turns around it.
 */
import { Schema } from "effect";
import {
  Attachment,
  type ContextCompactionDetail,
  type SessionStatus,
  type TodoListDetail,
  type TodoStep,
  type TranscriptRow,
} from "@hercule/contract";
import { readJsonObject } from "../json-shape";
import type { AgentState } from "./agent-state";
import {
  describeCompactionTarget,
  readCompactionDetail,
  readFetchedUrl,
  readToolCallName,
  readTodoListDetail,
  readUnknownLabel,
  summarizeTodoList,
} from "./item-detail";

type ProviderEvent = TranscriptRow["event"];
type ItemStarted = Extract<ProviderEvent, { _tag: "item.started" }>;
type ItemKind = ItemStarted["kind"];
type ItemUpdated = Extract<ProviderEvent, { _tag: "item.updated" }>;
type ItemCompleted = Extract<ProviderEvent, { _tag: "item.completed" }>;
type TurnEndState = Extract<ProviderEvent, { _tag: "turn.completed" }>["state"];

export interface ThreadItem {
  readonly itemId: string;
  /** The item's kind as the transcript names it, such as `command_execution` or `subagent`. */
  readonly kind: ItemKind;
  readonly verb: string;
  readonly target: string;
  /**
   * `awaiting approval` marks a running item an open Request of the agent is
   * about. The text is decided here rather than in the column that shows it,
   * so both screens that render an item show the same text.
   */
  readonly result: "completed" | "failed" | "declined" | "running" | "awaiting approval";
  /**
   * The steps of a `todo_list` item, in the agent's order, as of its latest
   * update. Empty for any other item, and for a list that has no steps.
   */
  readonly todoSteps: readonly TodoStep[];
}

/** The steps of every item that is not a todo list. One shared array, so a memoized component sees the same value on each projection. */
const NO_TODO_STEPS: readonly TodoStep[] = Object.freeze([]);

/** Returns the steps `todoList` holds, or `NO_TODO_STEPS` when it is absent or has none. */
const readTodoSteps = (todoList: TodoListDetail | undefined): readonly TodoStep[] =>
  todoList === undefined || todoList.steps.length === 0 ? NO_TODO_STEPS : todoList.steps;

const isAttachment = Schema.is(Attachment);

/**
 * The attachments of every message sent with no images. It is one shared
 * array, so a memoized component that takes a message's attachments sees the
 * same value each time the transcript is grouped again.
 */
const NO_ATTACHMENTS: readonly Attachment[] = Object.freeze([]);

/**
 * Returns the images a `user_message` item's detail lists in `attachments`:
 * references to uploaded images, never their bytes. Returns `NO_ATTACHMENTS`
 * when the message had no images. An entry that is not a well-formed
 * attachment is skipped, so a transcript written by an older or newer
 * controller still renders.
 */
const readUserAttachments = (detail: unknown): readonly Attachment[] => {
  const attachments = readJsonObject(detail)?.attachments;
  const valid = Array.isArray(attachments)
    ? (attachments as readonly unknown[]).filter(isAttachment)
    : [];
  return valid.length === 0 ? NO_ATTACHMENTS : valid;
};

/** The skills of every message that used none. One shared array, for the same reason as `NO_ATTACHMENTS`. */
const NO_SKILLS: readonly string[] = Object.freeze([]);

/**
 * Returns the names a `user_message` item's detail lists in `skills`: the
 * skills the runner found in the message and translated for the harness,
 * without the `$`. Returns `NO_SKILLS` when there are none. An entry that is
 * not a string is skipped, so a transcript written by an older or newer
 * runner still renders.
 */
const readUserSkills = (detail: unknown): readonly string[] => {
  const skills = readJsonObject(detail)?.skills;
  const valid = Array.isArray(skills)
    ? (skills as readonly unknown[]).filter((name): name is string => typeof name === "string")
    : [];
  return valid.length === 0 ? NO_SKILLS : valid;
};

/**
 * Returns the id of the session whose agent sent a `user_message`, from its
 * detail's `senderSessionId`. Returns `undefined` for a message the session's
 * owner sent, which carries no sender.
 */
export const readUserSender = (detail: unknown): string | undefined => {
  const sender = readJsonObject(detail)?.senderSessionId;
  return typeof sender === "string" && sender !== "" ? sender : undefined;
};

/**
 * Checks whether a `user_message` was steered into a turn that was already
 * running, from its detail's `steered`. Returns `false` for a message that
 * opened its turn.
 */
const isSteeredUserMessage = (detail: unknown): boolean => readJsonObject(detail)?.steered === true;

/** One message sent into a turn: by the session's owner, or by another session's agent. */
export interface ThreadUserMessage {
  readonly itemId: string;
  readonly text: string;
  /** The images sent with the message, in the order they were attached. Empty when none were. */
  readonly attachments: readonly Attachment[];
  /**
   * The names of the skills the runner translated for the harness, without the
   * `$`, such as `review` or `webshop:release`. Only a `$name` in the text that
   * is in this list is drawn as a skill. Empty when the message used none, and
   * for a message still on its way in, which the runner has not read yet.
   */
  readonly skills: readonly string[];
  /** Whether the message was steered into the running turn rather than opening it. */
  readonly steered: boolean;
  /** The session whose agent sent the message. Absent when the owner sent it. */
  readonly senderSessionId?: string;
}

/**
 * Returns the message a `user_message` item's `item.started` holds. Each
 * message is kept on its own, because a message steered into a turn can come
 * from a different sender than the one that opened it. The thread's turns
 * and its blocks both build their messages here, so the two never read a
 * message differently.
 */
export const buildUserMessage = (event: ItemStarted): ThreadUserMessage => {
  const text = readJsonObject(event.detail)?.text;
  const senderSessionId = readUserSender(event.detail);
  return {
    itemId: event.itemId,
    text: typeof text === "string" ? text : "",
    attachments: readUserAttachments(event.detail),
    skills: readUserSkills(event.detail),
    steered: isSteeredUserMessage(event.detail),
    ...(senderSessionId === undefined ? {} : { senderSessionId }),
  };
};

/**
 * A `runtime.error` or `runtime.warning` row: something went wrong around the
 * work, such as a harness that is not installed. The message is shown as the
 * runner wrote it, and may hold a command between backticks.
 */
export interface RuntimeNote {
  /** Unique within one transcript: the row's position, with its severity. */
  readonly key: string;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly at: string;
}

/**
 * A runtime note that belongs to no turn, such as the error of a session that
 * failed to start: no turn ever began, so there is nothing to put it in.
 */
export interface OutsideRuntimeNote extends RuntimeNote {
  /** How many turns began before the runtime note, so a screen places it between turns. */
  readonly turnsBefore: number;
}

export interface ThreadTurn {
  readonly turnId: string;
  /** The messages sent into this turn, in transcript order: the one that opened it, then any steered in. */
  readonly userMessages: readonly ThreadUserMessage[];
  readonly items: readonly ThreadItem[];
  readonly assistantText: string;
  readonly startedAt: string;
  readonly duration: number | null;
  /**
   * How the turn ended: `completed`, `failed`, or `interrupted` when it was
   * stopped. `null` while no `turn.completed` has arrived, like `duration`.
   */
  readonly endState: TurnEndState | null;
  /** The runtime notes that fell inside this turn, in transcript order. */
  readonly runtimeNotes: readonly RuntimeNote[];
}

/** The verb shown for each item kind. It is one word per kind, never more detailed. */
const VERBS: Partial<Record<ItemKind, string>> = {
  reasoning: "reasoning",
  command_execution: "command",
  file_change: "edit",
  file_read: "read",
  file_search: "find",
  tool_call: "tool",
  web_search: "search",
  subagent: "subagent",
  plan: "plan",
  todo_list: "tasks",
  context_compaction: "compaction",
  error: "error",
};

/**
 * Returns the verb of an item, one word. A `web_search` item that fetched a
 * page (`readFetchedUrl`) reads "fetch", and one that searched reads
 * "search".
 */
const readItemVerb = (kind: ItemKind, detail: unknown): string =>
  kind === "web_search" && readFetchedUrl(detail) !== "" ? "fetch" : (VERBS[kind] ?? "unknown");

/** Long enough for a useful summary, short enough that a whole file never ends up in a row. */
const MAX_TARGET_LENGTH = 200;

/**
 * The field of an item's `detail` that is worth showing in a row, as it is
 * found (any JSON value), and whether it is code: a command, a path or a
 * search pattern is code; a query or a description is words.
 */
interface DetailField {
  readonly value: unknown;
  readonly isCode: boolean;
}

/**
 * Returns the field of an item's `detail` that is worth showing in a row: the
 * command a shell item ran, the path a file item changed or read, the pattern
 * a file search looked for, the URL a page fetch loaded, what a web search
 * searched for, or a tool call's description. The first of these that is
 * present wins, even when it is not a string. Returns `undefined` when none is
 * present. Each provider adapter shapes `detail` its own way, so every field
 * is optional (spec 06 §6.3).
 */
const findDetailField = (detail: Record<string, unknown>): DetailField | undefined => {
  const input = readJsonObject(detail.input);
  // A `file_change` of several files lists them in `paths`; the first one names the row.
  const firstPath = Array.isArray(detail.paths) ? (detail.paths[0] as unknown) : undefined;
  const code =
    input?.command ??
    detail.command ??
    input?.file_path ??
    detail.pattern ??
    detail.path ??
    firstPath ??
    detail.url;
  if (code !== undefined && code !== null) return { value: code, isCode: true };
  const words = input?.query ?? detail.query ?? input?.description ?? detail.description;
  return words === undefined || words === null ? undefined : { value: words, isCode: false };
};

/** Returns the first line of `text`, cut to `MAX_TARGET_LENGTH` with an ellipsis. */
const cutToTargetLine = (text: string): string => {
  const line = text.split("\n")[0] ?? "";
  return line.length > MAX_TARGET_LENGTH ? `${line.slice(0, MAX_TARGET_LENGTH)}…` : line;
};

/**
 * Returns a one-line summary of an item's `detail`, truncated to
 * `MAX_TARGET_LENGTH`. A string is used as it is. Any other value is
 * summarized by the field `findDetailField` finds, else by the tool's `name`;
 * when that value is not a string, the detail is shown as compact JSON.
 */
const summarizeDetail = (detail: unknown): string => {
  if (detail === undefined || detail === null) return "";
  if (typeof detail === "string") return cutToTargetLine(detail);
  const object = readJsonObject(detail) ?? {};
  const name = readToolCallName(object);
  const value = findDetailField(object)?.value ?? (name === "" ? undefined : name);
  return cutToTargetLine(typeof value === "string" ? value : JSON.stringify(detail));
};

/** What a tool call acted on, in one line, and whether that is code. */
export interface ToolCallTarget {
  readonly text: string;
  readonly isCode: boolean;
}

/**
 * Returns what a tool call acted on, in one line cut to `MAX_TARGET_LENGTH`:
 * the field `findDetailField` finds in its `detail`, when that is a string.
 * Returns an empty text otherwise. Unlike `summarizeDetail`, it never falls
 * back to the tool's name or the JSON, because the desktop's row already
 * shows the name as its label.
 */
export const describeToolCallTarget = (detail: unknown): ToolCallTarget => {
  const field = findDetailField(readJsonObject(detail) ?? {});
  return typeof field?.value === "string"
    ? { text: cutToTargetLine(field.value), isCode: field.isCode }
    : { text: "", isCode: false };
};

/**
 * What a projection pass reads from an `item.started` row: the item to draw,
 * and the parts of its detail that the pass needs again later. The detail is
 * decoded here and not again, so a row that streams in never costs a second
 * decode.
 */
export interface StartedItem {
  readonly item: ThreadItem;
  /**
   * The label of an `unknown` item (`readUnknownLabel`), or "" when it has
   * none and for any other kind.
   */
  readonly unknownLabel: string;
  /**
   * The decoded detail of a `context_compaction` item, or `undefined` for any
   * other kind and when the detail does not decode. The pass keeps the latest
   * one, from this row or from an `item.updated` row (`UpdatedItem`), to merge
   * with the detail of the row that completes the item (`buildCompletedItem`).
   */
  readonly compaction: ContextCompactionDetail | undefined;
  /**
   * The decoded detail of a `todo_list` item, or `undefined` for any other
   * kind and when the detail does not decode.
   */
  readonly todoList: TodoListDetail | undefined;
}

/**
 * Returns the one-line target of a todo list: its progress, then the step in
 * progress, such as "2/5 · Run the tests". Just the progress when no step is
 * in progress.
 */
const describeTodoListTarget = (list: TodoListDetail): string => {
  const { progress, current } = summarizeTodoList(list.steps);
  // A step is free text and can run over several lines.
  return cutToTargetLine(current === "" ? progress : `${progress} · ${current}`);
};

/**
 * Returns the parts of an `item.started`, `item.updated` or `item.completed`
 * row's detail that the projections draw from: the verb, the target and what
 * was decoded on the way (`StartedItem`). The verb is "fetch" for a
 * `web_search` item whose detail names a URL, so it is read again from every
 * row. The target is:
 *
 * - for a compaction, its token counts (`describeCompactionTarget`), or "" when
 *   its detail does not decode;
 * - for a todo list, its progress and current step (`describeTodoListTarget`),
 *   or "" when its detail does not decode;
 * - for an `unknown` item that has one, the label the adapter wrote;
 * - for any other item, a one-line summary of its detail.
 */
const readItemDetail = (
  event: ItemStarted | ItemUpdated | ItemCompleted,
): Pick<StartedItem, "unknownLabel" | "compaction" | "todoList"> &
  Pick<ThreadItem, "verb" | "target"> => {
  const unknownLabel = event.kind === "unknown" ? readUnknownLabel(event.detail) : "";
  const compaction =
    event.kind === "context_compaction" ? readCompactionDetail(event.detail) : undefined;
  const todoList = event.kind === "todo_list" ? readTodoListDetail(event.detail) : undefined;
  const target =
    event.kind === "context_compaction"
      ? compaction === undefined
        ? ""
        : describeCompactionTarget(compaction)
      : event.kind === "todo_list"
        ? todoList === undefined
          ? ""
          : describeTodoListTarget(todoList)
        : unknownLabel !== ""
          ? unknownLabel
          : summarizeDetail(event.detail);
  return {
    verb: readItemVerb(event.kind, event.detail),
    target,
    unknownLabel,
    compaction,
    todoList,
  };
};

/**
 * Returns the row the transcript shows for an item that has just started,
 * with the detail parts read on the way (`StartedItem`). The row has the
 * item's verb and `running` as its result until its `item.completed` row
 * lands. Its target is described in `readItemDetail`.
 *
 * A todo list is the exception to `running`: it is a snapshot of the agent's
 * steps, not a step that runs, and it stays open for the whole turn. It
 * starts `completed`, and a failed `item.completed` row still makes it
 * `failed`.
 */
export const buildStartedItem = (event: ItemStarted): StartedItem => {
  const { verb, target, ...detail } = readItemDetail(event);
  return {
    item: {
      itemId: event.itemId,
      kind: event.kind,
      verb,
      target,
      result: event.kind === "todo_list" ? "completed" : "running",
      todoSteps: readTodoSteps(detail.todoList),
    },
    ...detail,
  };
};

/** What `buildUpdatedItem` returns: the item with its new verb, target and steps, and the detail decoded on the way. */
export interface UpdatedItem<Item extends ThreadItem> {
  readonly item: Item;
  /** The label of an `unknown` item that has one in its new detail, otherwise "". */
  readonly unknownLabel: string;
  /** The decoded detail of a `todo_list` item, or `undefined` for any other kind. */
  readonly todoList: TodoListDetail | undefined;
  /**
   * The decoded detail of a `context_compaction` item, or `undefined` for any
   * other kind and when the detail does not decode. The caller keeps it as the
   * latest one for `buildCompletedItem`, replacing the one it held.
   */
  readonly compaction: ContextCompactionDetail | undefined;
}

/**
 * Returns `item` once an `item.updated` row `event` has replaced its detail,
 * with the verb, target and todo steps read from the new detail. A todo list's
 * `item.completed` row carries its final list and is applied the same way:
 * the latest detail wins, which also recovers a list whose last update lost
 * its detail to the frame limit. The result, and every field that does not
 * come from the detail, stay as they were. Returns `undefined` when the row
 * cannot be applied, and the caller then keeps the item as it is:
 *
 * - the row has no `detail`: the runner leaves it off an event that is too
 *   big for one frame, and a missing detail must never empty a list;
 * - the item is a todo list and the detail does not decode.
 */
export const buildUpdatedItem = <Item extends ThreadItem>(
  item: Item,
  event: ItemUpdated | ItemCompleted,
): UpdatedItem<Item> | undefined => {
  if (event.detail === undefined) return undefined;
  const { verb, target, unknownLabel, todoList, compaction } = readItemDetail(event);
  if (event.kind === "todo_list" && todoList === undefined) return undefined;
  return {
    item: { ...item, verb, target, todoSteps: readTodoSteps(todoList) },
    unknownLabel,
    todoList,
    compaction,
  };
};

/**
 * Returns `item` once its `item.completed` row `event` has landed: its result
 * is the row's status, and `compaction` is the detail of a compaction item
 * with the start and the completion merged, or `undefined` for any other kind
 * and when neither decodes.
 *
 * A compaction reports its token counts and summary when it completes, and
 * may have reported some of them (the trigger, the count before) when it
 * started or was updated. `latestCompaction` is the detail the latest of those
 * rows decoded to. The merge lets a field of the completion win over the same
 * field of that detail, so a summary given earlier survives a completion that
 * has none. When the row holds a compaction detail, the target is read from
 * the merged detail.
 * Without one, such as on a failed compaction, the target the start gave
 * stays.
 *
 * The desktop's blocks build their items on this too, so both screens end up
 * with the same words.
 */
export const buildCompletedItem = <Item extends ThreadItem>(
  item: Item,
  latestCompaction: ContextCompactionDetail | undefined,
  event: ItemCompleted,
): { readonly item: Item; readonly compaction: ContextCompactionDetail | undefined } => {
  const completion =
    item.kind === "context_compaction" ? readCompactionDetail(event.detail) : undefined;
  const compaction =
    latestCompaction === undefined && completion === undefined
      ? undefined
      : { ...latestCompaction, ...completion };
  return {
    item: {
      ...item,
      result: event.status,
      ...(completion === undefined || compaction === undefined
        ? {}
        : { target: describeCompactionTarget(compaction) }),
    },
    compaction,
  };
};

interface Building {
  turnId: string;
  startedAt: string;
  completedAt: string | null;
  endState: TurnEndState | null;
  userMessages: ThreadUserMessage[];
  items: ThreadItem[];
  itemIndex: Map<string, number>;
  /** The latest decoded detail of each running compaction, by item id (`StartedItem.compaction`, `UpdatedItem.compaction`). */
  latestCompactions: Map<string, ContextCompactionDetail>;
  assistantText: string;
  runtimeNotes: RuntimeNote[];
  /**
   * The item of the last `assistant_text` delta, used to insert a paragraph
   * break when a new item starts.
   */
  lastAssistantItemId: string | null;
}

/**
 * Checks whether a session in `status` may still be running the last turn of
 * its transcript, when no row ends that turn.
 *
 * Returns `false` for `exited` and `queued`, because no harness process runs
 * then. Returns `true` for any other status, because the status may be older
 * than the rows: a turn's rows reach the client over the stream as they are
 * written, and the session's new status only in a read after them. A session
 * becomes `idle` only through a row, `turn.completed` or `session.started`,
 * so one that reads `idle` or `starting` while its last turn has no end has
 * not been read again since that turn started.
 */
export const mayBeRunningTurn = (status: SessionStatus): boolean =>
  status !== "exited" && status !== "queued";

/**
 * Returns a `runtime.error` or `runtime.warning` row as a runtime note. A row with
 * no message gets its error class as the message.
 */
const buildRuntimeNote = (
  row: TranscriptRow,
  event: Extract<ProviderEvent, { _tag: "runtime.error" | "runtime.warning" }>,
): RuntimeNote => ({
  key: `${event._tag}:${String(row.position)}`,
  severity: event._tag === "runtime.error" ? "error" : "warning",
  message: event._tag === "runtime.error" ? (event.message ?? event.class) : event.message,
  at: event.at,
});

/** What `buildTurns` returns: the turns, and the runtime notes that fell outside all of them. */
export interface ThreadTurns {
  readonly turns: readonly ThreadTurn[];
  readonly outsideRuntimeNotes: readonly OutsideRuntimeNote[];
}

/**
 * Returns the turns of one agent's transcript, in the order they first
 * appear, and the runtime notes that belong to no turn. `agent` is that agent's
 * state: an item one of its open Requests is about shows `awaiting approval`.
 *
 * A runtime note belongs to the turn its row names. A runtime note with no turn id
 * belongs to the turn that is open where its row sits: begun, and not yet
 * completed, nor cut off by the session starting or exiting. With no such
 * turn, it is an outside runtime note.
 */
export const buildTurns = (rows: readonly TranscriptRow[], agent: AgentState): ThreadTurns => {
  const awaitingItemIds = new Set(agent.openRequests.map((request) => request.itemId));
  const turns = new Map<string, Building>();

  const findOrStartTurn = (turnId: string, fallbackAt: string): Building => {
    const held = turns.get(turnId);
    if (held !== undefined) return held;
    const made: Building = {
      turnId,
      startedAt: fallbackAt,
      completedAt: null,
      endState: null,
      userMessages: [],
      items: [],
      itemIndex: new Map(),
      latestCompactions: new Map(),
      assistantText: "",
      runtimeNotes: [],
      lastAssistantItemId: null,
    };
    turns.set(turnId, made);
    return made;
  };

  const outsideRuntimeNotes: OutsideRuntimeNote[] = [];
  let openTurnId: string | null = null;

  for (const row of rows) {
    const event: ProviderEvent = row.event;
    switch (event._tag) {
      case "turn.started": {
        findOrStartTurn(event.turnId, event.at).startedAt = event.at;
        openTurnId = event.turnId;
        break;
      }
      case "turn.completed": {
        const turn = findOrStartTurn(event.turnId, event.at);
        turn.completedAt = event.at;
        turn.endState = event.state;
        openTurnId = null;
        break;
      }
      case "session.started":
      case "session.exited": {
        openTurnId = null;
        break;
      }
      case "runtime.error":
      case "runtime.warning": {
        const note = buildRuntimeNote(row, event);
        const turnId = event.turnId ?? openTurnId;
        if (turnId === null) {
          outsideRuntimeNotes.push({ ...note, turnsBefore: turns.size });
        } else {
          findOrStartTurn(turnId, event.at).runtimeNotes.push(note);
        }
        break;
      }
      case "item.started": {
        const turn = findOrStartTurn(event.turnId, event.at);
        if (event.kind === "user_message") {
          turn.userMessages.push(buildUserMessage(event));
        } else if (event.kind !== "assistant_message") {
          const { item, compaction } = buildStartedItem(event);
          turn.itemIndex.set(event.itemId, turn.items.length);
          turn.items.push(item);
          if (compaction !== undefined) turn.latestCompactions.set(event.itemId, compaction);
        }
        break;
      }
      case "item.updated": {
        // The row only changes an item that started; there is nothing to
        // start from otherwise, and a message's text never comes from it.
        const turn = turns.get(event.turnId);
        const index = turn?.itemIndex.get(event.itemId);
        if (turn === undefined || index === undefined) break;
        const updated = buildUpdatedItem(turn.items[index]!, event);
        if (updated === undefined) break;
        turn.items[index] = updated.item;
        if (updated.compaction !== undefined) {
          turn.latestCompactions.set(event.itemId, updated.compaction);
        }
        break;
      }
      case "item.completed": {
        const turn = findOrStartTurn(event.turnId, event.at);
        if (event.kind === "user_message" || event.kind === "assistant_message") break;
        const index = turn.itemIndex.get(event.itemId);
        if (index === undefined) break;
        const current = turn.items[index]!;
        turn.items[index] = buildCompletedItem(
          event.kind === "todo_list"
            ? (buildUpdatedItem(current, event)?.item ?? current)
            : current,
          turn.latestCompactions.get(event.itemId),
          event,
        ).item;
        break;
      }
      case "content.delta": {
        if (event.streamKind !== "assistant_text") break;
        const turn = findOrStartTurn(event.turnId, event.at);
        // A turn can make any number of model calls, so its text can come
        // from several assistant_message items. Start each new item on a new
        // paragraph, so two items never run together as one sentence.
        if (turn.lastAssistantItemId !== null && turn.lastAssistantItemId !== event.itemId) {
          turn.assistantText += "\n\n";
        }
        turn.assistantText += event.delta;
        turn.lastAssistantItemId = event.itemId;
        break;
      }
      default:
        break;
    }
  }

  const builtTurns = Array.from(turns.values()).map((turn) => ({
    turnId: turn.turnId,
    userMessages: turn.userMessages,
    // Only a running item can be waiting for an open Request. An item the
    // harness already finished keeps its result, even if a Request still
    // refers to it.
    items: turn.items.map((item) =>
      awaitingItemIds.has(item.itemId) && item.result === "running"
        ? { ...item, result: "awaiting approval" as const }
        : item,
    ),
    assistantText: turn.assistantText,
    startedAt: turn.startedAt,
    duration:
      turn.completedAt === null ? null : Date.parse(turn.completedAt) - Date.parse(turn.startedAt),
    endState: turn.endState,
    runtimeNotes: turn.runtimeNotes,
  }));
  return { turns: builtTurns, outsideRuntimeNotes };
};
