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
 *   transcript order.
 */
import { Schema } from "effect";
import { Attachment, type SessionStatus, type TranscriptRow } from "@hercule/contract";
import { readJsonObject } from "../json-shape";
import type { AgentState } from "./agent-state";

type ProviderEvent = TranscriptRow["event"];
type ItemStarted = Extract<ProviderEvent, { _tag: "item.started" }>;
type ItemKind = ItemStarted["kind"];
type ItemStatus = Extract<ProviderEvent, { _tag: "item.completed" }>["status"];
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
}

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
    steered: isSteeredUserMessage(event.detail),
    ...(senderSessionId === undefined ? {} : { senderSessionId }),
  };
};

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
}

/** The verb shown for each item kind. It is one word per kind, never more detailed. */
const VERBS: Partial<Record<ItemKind, string>> = {
  reasoning: "reasoning",
  command_execution: "command",
  file_change: "edit",
  tool_call: "tool",
  web_search: "search",
  subagent: "subagent",
  plan: "plan",
  context_compaction: "compaction",
  error: "error",
};

const readItemVerb = (kind: ItemKind): string => VERBS[kind] ?? "unknown";

/** Long enough for a useful summary, short enough that a whole file never ends up in a row. */
const MAX_TARGET_LENGTH = 200;

/**
 * Returns the field of an item's `detail` that is worth showing in a row: the
 * command a shell item ran, the path a file item changed, what a web search
 * searched for, or a tool call's description. Returns `undefined` when none
 * of these is present, and the caller then shows the raw JSON. Each provider
 * adapter shapes `detail` its own way, so every field is optional (spec 06
 * §6.3).
 */
const findDetailText = (detail: Record<string, unknown>): string | undefined => {
  const input = readJsonObject(detail.input);
  const candidate =
    input?.command ??
    detail.command ??
    input?.file_path ??
    detail.path ??
    input?.query ??
    input?.description ??
    detail.description ??
    detail.name;
  return typeof candidate === "string" ? candidate : undefined;
};

/**
 * Returns a one-line summary of an item's `detail`, truncated to
 * `MAX_TARGET_LENGTH`. A string is used as it is; any other value is
 * summarized by `findDetailText`, or else shown as compact JSON.
 */
const summarizeDetail = (detail: unknown): string => {
  if (detail === undefined || detail === null) return "";
  const text =
    typeof detail === "string"
      ? detail
      : (findDetailText(readJsonObject(detail) ?? {}) ?? JSON.stringify(detail));
  const line = text.split("\n")[0] ?? "";
  return line.length > MAX_TARGET_LENGTH ? `${line.slice(0, MAX_TARGET_LENGTH)}…` : line;
};

/**
 * Returns the row the transcript shows for an item that has just started: its
 * verb, a one-line summary of its detail as the target, and `running` as its
 * result until its `item.completed` row lands.
 */
export const buildThreadItem = (event: ItemStarted): ThreadItem => ({
  itemId: event.itemId,
  kind: event.kind,
  verb: readItemVerb(event.kind),
  target: summarizeDetail(event.detail),
  result: "running",
});

interface Building {
  turnId: string;
  startedAt: string;
  completedAt: string | null;
  endState: TurnEndState | null;
  userMessages: ThreadUserMessage[];
  items: ThreadItem[];
  itemIndex: Map<string, number>;
  assistantText: string;
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
 * Returns the turns of one agent's transcript, in the order they first
 * appear. `agent` is that agent's state: an item one of its open Requests is
 * about shows `awaiting approval`.
 */
export const buildTurns = (
  rows: readonly TranscriptRow[],
  agent: AgentState,
): readonly ThreadTurn[] => {
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
      assistantText: "",
      lastAssistantItemId: null,
    };
    turns.set(turnId, made);
    return made;
  };

  for (const row of rows) {
    const event: ProviderEvent = row.event;
    switch (event._tag) {
      case "turn.started": {
        findOrStartTurn(event.turnId, event.at).startedAt = event.at;
        break;
      }
      case "turn.completed": {
        const turn = findOrStartTurn(event.turnId, event.at);
        turn.completedAt = event.at;
        turn.endState = event.state;
        break;
      }
      case "item.started": {
        const turn = findOrStartTurn(event.turnId, event.at);
        if (event.kind === "user_message") {
          turn.userMessages.push(buildUserMessage(event));
        } else if (event.kind !== "assistant_message") {
          turn.itemIndex.set(event.itemId, turn.items.length);
          turn.items.push(buildThreadItem(event));
        }
        break;
      }
      case "item.completed": {
        const turn = findOrStartTurn(event.turnId, event.at);
        if (event.kind === "user_message" || event.kind === "assistant_message") break;
        const index = turn.itemIndex.get(event.itemId);
        if (index === undefined) break;
        const status: ItemStatus = event.status;
        turn.items[index] = { ...turn.items[index]!, result: status };
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

  return Array.from(turns.values()).map((turn) => ({
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
  }));
};
