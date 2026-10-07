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
 * names the assistant text it holds by its `itemId`, the id the text's
 * transcript rows carry. A reply with a null `itemId` joins every text of its
 * turn that no reply held before it.
 */
import type { Assistant, ConversationMessage, Session, TranscriptRow } from "@hercule/contract";
import { formatMessageTime } from "../threads/message-time";
import { findOpenItem } from "../threads/open-item";
import { describePose, type Pose } from "../threads/pose";
import { formatDayStamp } from "../time-context";

type ProviderEvent = TranscriptRow["event"];
type ItemStatus = Extract<ProviderEvent, { _tag: "item.completed" }>["status"];
type TurnEndState = Extract<ProviderEvent, { _tag: "turn.completed" }>["state"];

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
  /**
   * The text the transcript rows hold, not a stored message's text. The text
   * still streaming is in the tail, not here.
   */
  readonly rowText: string;
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
  /**
   * The running turn, or `null` while only the caret shows for a turn whose
   * first row has not arrived yet.
   */
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
  /** The text of its rows that the controller reads for a reply. */
  rowText: string;
  /** How the item completed, or `null` while it has not. */
  status: ItemStatus | null;
}

/** How the running turn ended, as its rows record it. */
interface TurnEnd {
  /** The time of the row that ended it. */
  readonly at: string;
  /** The turn's end state, or `null` when the session exited or started again before it. */
  readonly state: TurnEndState | null;
}

/** The running turn as its transcript rows hold it. */
interface RunningTurn {
  readonly turnId: string;
  /** In the order the items were placed. */
  readonly texts: readonly AssistantText[];
  /**
   * The ids of the texts that completed, in the order they completed. In
   * `segments` mode the controller stores texts in this order.
   */
  readonly completedIds: readonly string[];
  /** The text whose first text row came last, or `null` when no text has a row. */
  readonly lastText: AssistantText | null;
  /** `null` while the rows hold no end of the turn. */
  readonly end: TurnEnd | null;
}

/**
 * Returns the rows of a session's running turn: the rows from the newest
 * `turn.started` in `rows` on, oldest first, as `rows` are. Returns `rows`
 * itself when they hold no `turn.started` or already start with the newest
 * one.
 *
 * The screen applies it as rows stream in, so the rows it holds for a session
 * never grow past the running turn, however many turns the session runs.
 */
export const trimToRunningTurn = (rows: readonly TranscriptRow[]): readonly TranscriptRow[] => {
  const start = rows.findLastIndex((row) => row.event._tag === "turn.started");
  return start <= 0 ? rows : rows.slice(start);
};

/**
 * Returns the rows of a session's running turn from the rows read so far,
 * newest first, as the screen reads the transcript a page at a time:
 *
 * - `reachedTurnStart` is true once the rows hold a `turn.started`. The
 *   screen stops reading pages then.
 * - `rows` holds the rows from the newest `turn.started` on, oldest first,
 *   by `trimToRunningTurn`. Before one is reached, it holds every row read so
 *   far, oldest first, so the screen still knows the newest row it holds.
 */
export const collectRunningTurnRows = (
  rowsNewestFirst: readonly TranscriptRow[],
): { readonly reachedTurnStart: boolean; readonly rows: readonly TranscriptRow[] } => {
  const rows = trimToRunningTurn([...rowsNewestFirst].reverse());
  return { reachedTurnStart: rows[0]?.event._tag === "turn.started", rows };
};

/**
 * Reads the running turn from `rows`, or returns `null` when they hold no
 * `turn.started`. The turn is the one the newest `turn.started` names, and
 * only the rows from it on are read.
 *
 * The texts are read the way the controller reads them when it stores a
 * reply, which depends on the reply mode (`reply`):
 *
 * - Only `assistant_text` rows that name the running turn count.
 * - In `turn-end` mode, the controller reads the turn's text rows from its
 *   start, so a text is placed by its `item.started`, or by its first text
 *   row when that comes first.
 * - In `segments` mode, the controller reads an item's text rows from its
 *   `item.started` on, and stores nothing for an item with no
 *   `item.started`. So a text is placed only by its `item.started`, and text
 *   rows before it are skipped.
 *
 * The turn ends at its `turn.completed`, or, cut short, at a later
 * `session.exited` or `session.started`: a harness that exited, or a new one
 * that started, runs no turn of the one before. An item is completed by its
 * `item.completed`, found by item id, because a harness can complete an item
 * under a later turn.
 */
const readRunningTurn = (
  rows: readonly TranscriptRow[],
  reply: Assistant["reply"],
): RunningTurn | null => {
  const start = rows.findLastIndex((row) => row.event._tag === "turn.started");
  const started = rows[start]?.event;
  if (started?._tag !== "turn.started") return null;
  const turnId = started.turnId;

  const texts: AssistantText[] = [];
  const byId = new Map<string, AssistantText>();
  const withTextRow = new Set<string>();
  const completedIds: string[] = [];
  let lastText: AssistantText | null = null;
  let end: TurnEnd | null = null;
  const placeText = (itemId: string): AssistantText => {
    const text: AssistantText = { itemId, rowText: "", status: null };
    texts.push(text);
    byId.set(itemId, text);
    return text;
  };

  for (const { event } of rows.slice(start + 1)) {
    if (event._tag === "turn.completed" && event.turnId === turnId) {
      end ??= { at: event.at, state: event.state };
    } else if (event._tag === "session.exited" || event._tag === "session.started") {
      end ??= { at: event.at, state: null };
    } else if (
      event._tag === "item.started" &&
      event.kind === "assistant_message" &&
      event.turnId === turnId &&
      !byId.has(event.itemId)
    ) {
      placeText(event.itemId);
    } else if (
      event._tag === "content.delta" &&
      event.streamKind === "assistant_text" &&
      event.turnId === turnId
    ) {
      const text =
        byId.get(event.itemId) ?? (reply === "turn-end" ? placeText(event.itemId) : undefined);
      if (text === undefined) continue;
      text.rowText += event.delta;
      if (!withTextRow.has(text.itemId)) {
        withTextRow.add(text.itemId);
        lastText = text;
      }
    } else if (event._tag === "item.completed") {
      const text = byId.get(event.itemId);
      if (text !== undefined && text.status === null) {
        text.status = event.status;
        completedIds.push(event.itemId);
      }
    }
  }
  return { turnId, texts, completedIds, lastText, end };
};

/**
 * Returns the running turn's texts that the controller stores, or has stored,
 * when it stores one reply per turn (`turn-end`). The caller hides those a
 * stored reply holds already. The texts are:
 *
 * - While the turn runs, the text the assistant is still writing, when it is
 *   the last one placed. Its words are in the tail until it completes, so its
 *   rows may hold no text yet.
 * - Else the text whose first text row came last, when it holds text. The
 *   controller stores that one when the turn completes. A later text that
 *   completed empty has no text row, so it never hides the one before it.
 * - When the turn failed or was stopped, every text that holds text, because
 *   the controller then stores them joined, leaving out those a reply already
 *   holds.
 * - None when the turn was cut short: the controller stores no reply then.
 */
const listTurnEndTexts = (turn: RunningTurn): readonly AssistantText[] => {
  if (turn.end !== null && turn.end.state !== "completed") {
    return turn.end.state === null ? [] : turn.texts.filter((text) => text.rowText !== "");
  }
  const last = turn.texts.at(-1);
  if (last !== undefined && last.status === null && turn.end === null) return [last];
  return turn.lastText !== null && turn.lastText.rowText !== "" ? [turn.lastText] : [];
};

/**
 * Returns the running turn's texts that no stored reply holds yet, when the
 * controller stores a reply per text (`segments`). `storedItemIds` are the
 * texts the turn's stored replies hold.
 *
 * The controller stores a text when it completes with status `completed` and
 * holds text, so texts are stored in the order they complete. A stored text
 * therefore means every text that completed before it is stored too. That
 * holds even when the messages read so far do not reach those earlier
 * replies, as when the turn stored more replies than one page of messages
 * holds. The texts shown are:
 *
 * - the texts that completed after the last stored one and that the
 *   controller will store;
 * - the texts the assistant is still writing, while the turn runs.
 *
 * A text that failed, was declined, or holds no text is never stored, and a
 * text cut off by the turn's end is never completed, so neither shows.
 */
const listSegmentTexts = (
  turn: RunningTurn,
  storedItemIds: ReadonlySet<string>,
): readonly AssistantText[] => {
  const lastStored = turn.completedIds.findLastIndex((itemId) => storedItemIds.has(itemId));
  return turn.texts.filter((text) =>
    text.status === null
      ? turn.end === null
      : text.status === "completed" &&
        text.rowText !== "" &&
        turn.completedIds.indexOf(text.itemId) > lastStored,
  );
};

/**
 * Checks whether the owner sent a message after the running turn ended, so
 * the session, while busy, is about to start the turn that answers it. The
 * end is the row that ended the turn, compared by time, or, before that row
 * has arrived, the turn's joined reply (`joinedReply`), compared by position.
 * Returns false while the turn has not ended.
 */
const isOwnerMessageAfterTurnEnd = (
  messages: readonly ConversationMessage[],
  turn: RunningTurn,
  joinedReply: ConversationMessage | undefined,
): boolean => {
  const ownerMessage = messages.findLast((message) => message.senderRole === "owner");
  if (ownerMessage === undefined) return false;
  if (turn.end !== null) return Date.parse(ownerMessage.createdAt) > Date.parse(turn.end.at);
  return joinedReply !== undefined && ownerMessage.position > joinedReply.position;
};

/**
 * Decides the open reply: the reply the assistant is writing in the running
 * turn, as far as no stored message holds it. Returns `null` when there is
 * none.
 *
 * - `messages` are the Conversation's messages held so far, oldest first.
 * - `runningTurnRows` are the current session's rows, oldest first. Only the
 *   rows from the newest `turn.started` on are read (see
 *   `trimToRunningTurn`).
 * - `session` is the current session, or `null` when there is none.
 * - `reply` is the assistant's reply mode, which decides what is shown:
 *   - `turn-end`: the turn's newest text, or every text when the turn
 *     failed or was stopped (see `listTurnEndTexts`);
 *   - `segments`: the turn's texts that completed after the last stored one,
 *     and the texts being written (see `listSegmentTexts`).
 * - `pose` is the assistant's pose, from `decideAssistantPose`, which the
 *   open reply's face shows.
 *
 * The texts follow the rules the controller stores replies by, so the open
 * reply never shows text that will not be stored (see `readRunningTurn`).
 * A text is hidden once a stored reply of the turn holds it: a reply with the
 * turn's `turnId` and the text's `itemId`. A reply with the turn's `turnId`
 * and a null `itemId` is a joined reply: it holds every text of the turn that
 * no reply held before it, so with the first rule, nothing of the turn is
 * shown once it is stored. Both rules apply in either
 * mode, because a change of mode applies at once, also to a running turn.
 *
 * While the session is `busy`, an open reply with no text, the caret alone,
 * is returned:
 *
 * - while the turn has not ended: its rows hold no `turn.completed`, no
 *   later `session.exited` or `session.started`, and no joined reply of the
 *   turn is stored. That covers a turn that is only using tools and a turn
 *   waiting on a Request. A stored reply that holds one text does not end
 *   the turn, because it may be a segment stored before the mode changed to
 *   `turn-end`. So in `turn-end` mode the caret alone shows from the moment
 *   the turn's reply is stored until its `turn.completed` row arrives;
 * - when the rows hold no turn yet;
 * - when the turn has ended and the owner sent a message after its end. That
 *   covers the moment between the owner's message and the next turn's first
 *   row. The caret then stands for the next turn, so its `turnId` is `null`.
 *
 * A turn that ended with no text to store, and no owner message after it,
 * leaves no open reply, even while the session still reads as `busy`.
 */
export const decideOpenReply = (input: {
  readonly messages: readonly ConversationMessage[];
  readonly runningTurnRows: readonly TranscriptRow[];
  readonly session: Session | null;
  readonly reply: Assistant["reply"];
  readonly pose: Pose;
}): OpenReplyBlock | null => {
  const busy = input.session?.status === "busy";
  const caret: OpenReplyBlock = {
    kind: "open-reply",
    key: "open-reply",
    turnId: null,
    items: [],
    openItemId: null,
    pose: input.pose,
  };
  const turn = readRunningTurn(input.runningTurnRows, input.reply);
  if (turn === null) return busy ? caret : null;

  const storedReplies = input.messages.filter(
    (message) => message.senderRole === "assistant" && message.turnId === turn.turnId,
  );
  // A joined reply is stored only when its turn ends, so it ends the turn
  // even while the turn's `turn.completed` row is on its way.
  const joinedReply = storedReplies.find((message) => message.itemId === null);
  const storedItemIds = new Set(
    storedReplies.flatMap(({ itemId }) => (itemId === null ? [] : [itemId])),
  );
  const ended = turn.end !== null || joinedReply !== undefined;
  if (ended && busy && isOwnerMessageAfterTurnEnd(input.messages, turn, joinedReply)) {
    return caret;
  }
  const shown =
    joinedReply !== undefined
      ? []
      : input.reply === "turn-end"
        ? listTurnEndTexts(turn).filter((text) => !storedItemIds.has(text.itemId))
        : listSegmentTexts(turn, storedItemIds);
  if (shown.length === 0 && (ended || !busy)) return null;

  const openItemId = ended ? null : findOpenItem(input.runningTurnRows);
  return {
    ...caret,
    turnId: turn.turnId,
    items: shown.map(({ itemId, rowText }) => ({ itemId, rowText })),
    openItemId: shown.some((text) => text.itemId === openItemId) ? openItemId : null,
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
