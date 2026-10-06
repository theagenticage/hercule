/**
 * The blocks of an assistant's Conversation as the desktop draws it: one flat
 * list in reading order, one block per item of the virtualized list.
 *
 * Two sources feed it:
 *
 * - the Conversation's stored messages: what the owner said, the replies and
 *   the notices;
 * - the running turn of the current session: the transcript rows from the
 *   session's newest `turn.started` on. They hold the reply the assistant is
 *   still writing, which no message holds yet.
 *
 * The two overlap: a reply is first text in the running turn and is then
 * stored as a message with the same `turnId`. The open reply shows only the
 * text not stored yet, so no text is drawn twice. Which text the controller
 * stores depends on the assistant's reply mode, so the open reply follows the
 * same rules (see `decideOpenReply`). Text is never compared: a stored reply
 * is matched to the turn's text by `turnId` and by count.
 */
import type { Assistant, ConversationMessage, Session, TranscriptRow } from "@hercule/contract";
import { formatMessageTime } from "../threads/message-time";
import { findOpenItem } from "../threads/open-item";
import { describePose, type Pose } from "../threads/pose";
import { formatDayStamp } from "../time-context";

type ProviderEvent = TranscriptRow["event"];
type ItemStatus = Extract<ProviderEvent, { _tag: "item.completed" }>["status"];

/** The day stamp above the first message of each day: "Today", "Yesterday", "4 Sep" or "4 Sep 2025". */
export interface DayStampBlock {
  readonly kind: "stamp";
  readonly key: string;
  readonly label: string;
}

/**
 * A stored message: the owner's (`owner`), a reply (`reply`), or a notice
 * (`notice`). A reply's face is always still and idle, and a notice's face is
 * in the failed pose; only the open reply's face moves.
 */
export interface StoredMessageBlock {
  readonly kind: "owner" | "reply" | "notice";
  readonly key: string;
  readonly message: ConversationMessage;
  /** When the message was stored, by `formatMessageTime`. `undefined` when it cannot be formatted. */
  readonly time: string | undefined;
}

/** One assistant text of the running turn that is not stored as a message yet. */
export interface OpenReplyItem {
  readonly itemId: string;
  /** The text the transcript rows hold. The text still streaming is in the tail, not here. */
  readonly storedText: string;
}

/**
 * The reply the assistant is writing: the running turn's text that no stored
 * message holds yet, or, while the turn has no such text, the caret alone.
 */
export interface OpenReplyBlock {
  readonly kind: "open-reply";
  /**
   * Always `open-reply`: one Conversation has at most one open reply, and a
   * constant key keeps its row, and its moving face, mounted while the turn's
   * first rows arrive.
   */
  readonly key: string;
  /** The running turn, or `null` before its first row has arrived. */
  readonly turnId: string | null;
  /** In the order the assistant started writing them. Empty when only the caret shows. */
  readonly items: readonly OpenReplyItem[];
  /**
   * The item the assistant is still writing, whose streaming tail is painted
   * after its stored text, as `findOpenItem` finds it. `null` when no shown
   * item is being written.
   */
  readonly openItemId: string | null;
  /** The pose of the assistant's face, the only face in the Conversation that moves. */
  readonly pose: Pose;
}

export type ConversationBlock = DayStampBlock | StoredMessageBlock | OpenReplyBlock;

/** An assistant text of the running turn, as its transcript rows hold it. */
interface AssistantText {
  readonly itemId: string;
  text: string;
  /** How the item completed, or `null` while it has not. */
  status: ItemStatus | null;
}

/** The running turn as its transcript rows hold it. */
interface RunningTurn {
  readonly turnId: string;
  /** In the order the items started. */
  readonly texts: readonly AssistantText[];
  /** The ids of the texts that completed, in the order they completed. */
  readonly completedIds: readonly string[];
  /** Whether the rows hold the turn's `turn.completed`. */
  readonly ended: boolean;
}

/**
 * Returns the rows of a session's running turn from the rows read so far,
 * newest first, as the screen reads the transcript a page at a time:
 *
 * - `reachedTurnStart` is true once the rows hold a `turn.started`. The
 *   screen stops reading pages then.
 * - `rows` holds the rows from the newest `turn.started` on, oldest first.
 *   Before one is reached, it holds every row read so far, oldest first, so
 *   the screen still knows the newest row it holds.
 */
export const collectRunningTurnRows = (
  rowsNewestFirst: readonly TranscriptRow[],
): { readonly reachedTurnStart: boolean; readonly rows: readonly TranscriptRow[] } => {
  const start = rowsNewestFirst.findIndex((row) => row.event._tag === "turn.started");
  const kept = start === -1 ? rowsNewestFirst : rowsNewestFirst.slice(0, start + 1);
  return { reachedTurnStart: start !== -1, rows: [...kept].reverse() };
};

/**
 * Reads the running turn from `rows`, or returns `null` when they hold no
 * `turn.started`. The turn is the one the newest `turn.started` names.
 *
 * Its assistant texts are read the way `buildThreadBlocks` reads a thread's
 * agent messages: a text is placed by its `item.started`, or by its first
 * text row when that comes first, and its text is its `assistant_text` rows
 * joined. An item is completed by its `item.completed`, found by item id,
 * because a harness can complete an item under a later turn.
 */
const readRunningTurn = (rows: readonly TranscriptRow[]): RunningTurn | null => {
  const started = rows.findLast((row) => row.event._tag === "turn.started")?.event;
  if (started?._tag !== "turn.started") return null;
  const turnId = started.turnId;

  const texts: AssistantText[] = [];
  const byId = new Map<string, AssistantText>();
  const completedIds: string[] = [];
  let ended = false;
  const placeText = (itemId: string): AssistantText => {
    const text: AssistantText = { itemId, text: "", status: null };
    texts.push(text);
    byId.set(itemId, text);
    return text;
  };

  for (const { event } of rows) {
    if (event._tag === "turn.completed" && event.turnId === turnId) {
      ended = true;
    } else if (
      event._tag === "item.started" &&
      event.kind === "assistant_message" &&
      event.turnId === turnId &&
      !byId.has(event.itemId)
    ) {
      placeText(event.itemId);
    } else if (event._tag === "content.delta" && event.streamKind === "assistant_text") {
      const text =
        byId.get(event.itemId) ?? (event.turnId === turnId ? placeText(event.itemId) : undefined);
      if (text !== undefined) text.text += event.delta;
    } else if (event._tag === "item.completed") {
      const text = byId.get(event.itemId);
      if (text !== undefined && text.status === null) {
        text.status = event.status;
        completedIds.push(event.itemId);
      }
    }
  }
  return { turnId, texts, completedIds, ended };
};

/**
 * Returns the running turn's texts that no stored reply holds yet, when the
 * controller stores one reply per turn (`turn-end`): the turn's last text,
 * when the turn has stored no reply. Earlier texts show only until the next
 * one starts, because the controller never stores them on their own.
 *
 * A last text with no text is not shown, unless the assistant is still
 * writing it: the controller stores no empty reply.
 */
const listTurnEndTexts = (turn: RunningTurn, storedCount: number): readonly AssistantText[] => {
  const last = turn.texts.at(-1);
  if (storedCount > 0 || last === undefined) return [];
  const writing = last.status === null && !turn.ended;
  return writing || last.text !== "" ? [last] : [];
};

/**
 * Returns the running turn's texts that no stored reply holds yet, when the
 * controller stores a reply per text (`segments`). The controller stores a
 * text when it completes with status `completed` and holds text, in the order
 * texts complete. So the first `storedCount` such texts are stored, and the
 * texts shown are:
 *
 * - the other texts that the controller will store;
 * - the texts the assistant is still writing, while the turn runs.
 *
 * A text that failed, was declined, or holds no text is never stored, and a
 * text cut off by the turn's end is never completed, so neither shows.
 */
const listSegmentTexts = (turn: RunningTurn, storedCount: number): readonly AssistantText[] => {
  const willBeStored = (text: AssistantText): boolean =>
    text.status === "completed" && text.text !== "";
  const storedIds = new Set(
    turn.completedIds
      .filter((itemId) => turn.texts.some((text) => text.itemId === itemId && willBeStored(text)))
      .slice(0, storedCount),
  );
  return turn.texts.filter((text) =>
    text.status === null ? !turn.ended : willBeStored(text) && !storedIds.has(text.itemId),
  );
};

/**
 * Decides the open reply: the reply the assistant is writing in the running
 * turn, as far as no stored message holds it. Returns `null` when there is
 * none.
 *
 * - `messages` are the Conversation's messages held so far, oldest first.
 * - `runningTurnRows` are the current session's rows from its newest
 *   `turn.started` on, oldest first (see `collectRunningTurnRows`). Rows
 *   before that `turn.started` are ignored.
 * - `session` is the current session, or `null` when there is none.
 * - `reply` is the assistant's reply mode, which decides what is shown:
 *   - `turn-end`: the turn's newest text, until a reply with the turn's id is
 *     stored;
 *   - `segments`: the turn's texts after the first k, where k is the number
 *     of replies with the turn's id stored.
 * - `pose` is the assistant's pose, from `decideAssistantPose`, which the open
 *   reply's face shows.
 *
 * An open reply with no text, the caret alone, is returned while the session
 * is `busy` and the turn has not ended: the rows hold no `turn.completed`
 * for it and, in `turn-end` mode, no reply with its id is stored. That covers the moment
 * between the owner's message and the turn's first row, a turn that is only
 * using tools, and a turn waiting on a Request. A turn that ended with no text
 * to store leaves no open reply.
 */
export const decideOpenReply = (input: {
  readonly messages: readonly ConversationMessage[];
  readonly runningTurnRows: readonly TranscriptRow[];
  readonly session: Session | null;
  readonly reply: Assistant["reply"];
  readonly pose: Pose;
}): OpenReplyBlock | null => {
  const turn = readRunningTurn(input.runningTurnRows);
  const storedCount =
    turn === null
      ? 0
      : input.messages.filter(
          (message) => message.senderRole === "assistant" && message.turnId === turn.turnId,
        ).length;
  const shown =
    turn === null
      ? []
      : input.reply === "turn-end"
        ? listTurnEndTexts(turn, storedCount)
        : listSegmentTexts(turn, storedCount);
  // In `turn-end` mode a reply is stored only when its turn ends, so a stored
  // reply ends the turn even while its `turn.completed` row is on its way.
  const ended = turn?.ended === true || (input.reply === "turn-end" && storedCount > 0);
  const busy = input.session?.status === "busy" && !ended;
  if (shown.length === 0 && !busy) return null;

  const openItemId = turn !== null && !ended ? findOpenItem(input.runningTurnRows) : null;
  return {
    kind: "open-reply",
    key: "open-reply",
    turnId: turn?.turnId ?? null,
    items: shown.map(({ itemId, text }) => ({ itemId, storedText: text })),
    openItemId: shown.some((text) => text.itemId === openItemId) ? openItemId : null,
    pose: input.pose,
  };
};

const STORED_MESSAGE_KINDS = {
  owner: "owner",
  assistant: "reply",
  notice: "notice",
} as const satisfies Record<ConversationMessage["senderRole"], StoredMessageBlock["kind"]>;

/**
 * Returns the blocks of an assistant's Conversation in reading order:
 *
 * - a `stamp` block above the first message of each day, by
 *   `formatDayStamp` in `timezone`, relative to `now`;
 * - an `owner`, `reply` or `notice` block per stored message, by its sender,
 *   with its time by `formatMessageTime`;
 * - the open reply last, as `decideOpenReply` decides it. When no message
 *   was stored today, a "Today" stamp goes above it, so the stamp is already
 *   in place when the reply is stored.
 *
 * `messages` must be oldest first, as `flattenMessagePages` returns them. The
 * other inputs are those of `decideOpenReply`. A stamp's key is built from its
 * label, which no other stamp shows, and a message's from its id. Keys then
 * stay the same as earlier messages are read and new ones arrive: a stamp
 * keyed by the first message of its day would change key when an earlier
 * page adds messages from that day, and so would the stamp above the open
 * reply when the reply is stored.
 */
export const buildConversationBlocks = (input: {
  readonly messages: readonly ConversationMessage[];
  readonly runningTurnRows: readonly TranscriptRow[];
  readonly session: Session | null;
  readonly reply: Assistant["reply"];
  readonly pose: Pose;
  readonly timezone: string;
  readonly now: Date;
}): readonly ConversationBlock[] => {
  const { timezone, now } = input;
  const blocks: ConversationBlock[] = [];
  let shownDay: string | undefined;
  const placeStamp = (label: string | undefined): void => {
    if (label === undefined || label === shownDay) return;
    shownDay = label;
    blocks.push({ kind: "stamp", key: `stamp:${label}`, label });
  };

  for (const message of input.messages) {
    const createdAt = new Date(message.createdAt);
    placeStamp(formatDayStamp(createdAt, timezone, now));
    blocks.push({
      kind: STORED_MESSAGE_KINDS[message.senderRole],
      key: `message:${message.id}`,
      message,
      time: formatMessageTime(createdAt, timezone, now),
    });
  }

  const openReply = decideOpenReply(input);
  if (openReply !== null) {
    placeStamp(formatDayStamp(now, timezone, now));
    blocks.push(openReply);
  }
  return blocks;
};

/**
 * Returns the words beside the assistant's name on the open reply, where a
 * stored reply shows its time:
 *
 * - "answering…" while the assistant works and the reply has text;
 * - "thinking…" while the assistant works and only the caret shows;
 * - otherwise the word for the pose, such as "waiting on you" while a
 *   Request is open, by `describePose`.
 */
export const describeOpenReply = (block: OpenReplyBlock): string =>
  block.pose !== "working"
    ? describePose(block.pose)
    : block.items.length === 0
      ? "thinking…"
      : "answering…";
