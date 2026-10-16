/**
 * How a conversation shows a reply to a Scheduled Wake: a heartbeat the
 * assistant answered with nothing to report folds into one muted line, a run
 * of such replies folds into one line together, and every other reply to a
 * wake carries a small label in its meta line.
 */
import type { ConversationMessage, ConversationWake } from "@hercule/contract";
import { formatClock, formatDay, isSameDay } from "../time-context";
import { chooseMessageStamps } from "./conversation";

/** The word that names each kind of Scheduled Wake. */
const WAKE_LABELS: Readonly<Record<ConversationWake, string>> = {
  heartbeat: "Heartbeat",
  reminder: "Reminder",
};

/**
 * Returns the label a reply to a Scheduled Wake carries in its meta line,
 * such as "Reminder", or `undefined` for a reply no wake opened. A quiet
 * heartbeat reply is never drawn on its own line: it folds into a `QuietRun`.
 */
export const chooseWakeLabel = (
  message: Pick<ConversationMessage, "wake" | "quiet">,
): string | undefined =>
  message.wake === undefined || message.quiet === true ? undefined : WAKE_LABELS[message.wake];

/** One quiet heartbeat reply inside a `QuietRun`. */
export interface QuietBeat {
  readonly id: string;
  /** When the reply was stored, as the ISO instant `ConversationMessage` carries. */
  readonly createdAt: string;
  /** The reply's time of day, such as "10:00"; `undefined` when it cannot be formatted. */
  readonly time: string | undefined;
  /** What the assistant wrote besides `NO_REPLY`, or null when it wrote nothing else. */
  readonly note: string | null;
  /** The session that produced the reply, where its work can be read. */
  readonly sessionId: string | null;
}

/**
 * Consecutive quiet heartbeat replies from one day, drawn as one line.
 *
 * - `key` is stable while the run grows at its end, and is built from the id
 *   of its first reply.
 * - `summary` is the line's words, such as "3 heartbeats · nothing to report".
 * - `span` is when the run happened: "10:00" for one reply, "10:00-12:00" for
 *   several, `undefined` when the times cannot be formatted.
 */
export interface QuietRun {
  readonly key: string;
  readonly summary: string;
  readonly span: string | undefined;
  readonly beats: readonly QuietBeat[];
}

/**
 * One line of a conversation: a message drawn on its own, or a run of quiet
 * heartbeat replies drawn together. `stamp` is the time separator to show
 * above the line, or undefined for none: `chooseMessageStamps` decides it for
 * a message, and a run carries the day ("9 Oct") only when it starts a new
 * day, because its own line shows the time.
 */
export type ConversationLine =
  | {
      readonly kind: "message";
      readonly message: ConversationMessage;
      readonly stamp: string | undefined;
    }
  | { readonly kind: "quiet-run"; readonly run: QuietRun; readonly stamp: string | undefined };

/**
 * Returns the line's words for a run of one or more quiet replies. A run of
 * one says whether the assistant wrote anything besides `NO_REPLY`.
 */
const summarizeQuietRun = (beats: readonly QuietBeat[]): string => {
  const [only] = beats;
  if (only !== undefined && beats.length === 1) {
    return only.note === null ? "Heartbeat · nothing to report" : "Heartbeat · a short note";
  }
  const noted = beats.filter((beat) => beat.note !== null).length;
  const outcome =
    noted === 0
      ? "nothing to report"
      : noted === 1
        ? "1 with a note"
        : `${String(noted)} with notes`;
  return `${String(beats.length)} heartbeats · ${outcome}`;
};

/** Builds the run of the quiet replies in `messages`, which are consecutive and on one day. */
const buildQuietRun = (messages: readonly ConversationMessage[], timezone: string): QuietRun => {
  const beats = messages.map((message): QuietBeat => {
    const note = message.text.trim();
    return {
      id: message.id,
      createdAt: message.createdAt,
      time: formatClock(new Date(message.createdAt), timezone),
      note: note === "" ? null : note,
      sessionId: message.sessionId,
    };
  });
  const first = beats[0]?.time;
  const last = beats.at(-1)?.time;
  return {
    key: `quiet:${messages[0]?.id ?? ""}`,
    summary: summarizeQuietRun(beats),
    span: first === undefined || last === undefined || first === last ? first : `${first}-${last}`,
    beats,
  };
};

/**
 * Returns the lines of a conversation, oldest first, from its `messages`
 * oldest first: each message is a line, except that consecutive quiet
 * heartbeat replies fold into one `quiet-run` line.
 *
 * A run ends at any other message, and at midnight in `timezone`, so a run
 * never spans two days. Folding is by default and never hides a note: the
 * run's beats keep each reply's note and session.
 */
export const groupQuietReplies = (
  messages: readonly ConversationMessage[],
  timezone: string,
): readonly ConversationLine[] => {
  const stamps = chooseMessageStamps(messages, timezone);
  const lines: ConversationLine[] = [];
  let pending: ConversationMessage[] = [];
  let pendingStamp: string | undefined;
  const appendPendingQuietRun = (): void => {
    if (pending.length === 0) return;
    lines.push({ kind: "quiet-run", run: buildQuietRun(pending, timezone), stamp: pendingStamp });
    pending = [];
  };

  messages.forEach((message, index) => {
    const previous = messages[index - 1];
    if (message.quiet !== true) {
      appendPendingQuietRun();
      lines.push({ kind: "message", message, stamp: stamps[index] });
      return;
    }
    const createdAt = new Date(message.createdAt);
    const startsDay =
      previous === undefined || !isSameDay(createdAt, new Date(previous.createdAt), timezone);
    if (startsDay) appendPendingQuietRun();
    if (pending.length === 0) pendingStamp = startsDay ? formatDay(createdAt, timezone) : undefined;
    pending.push(message);
  });
  appendPendingQuietRun();
  return lines;
};

/**
 * Returns the id a line is found by on screen: the message's own id, or the
 * first beat's id for a quiet run. Returns `undefined` for a line with no
 * message, which a quiet run never is.
 */
const readLineRowId = (line: ConversationLine): string | undefined =>
  line.kind === "message" ? line.message.id : line.run.beats[0]?.id;

/**
 * Returns the row id of the line that now holds `messageId`, or `undefined`
 * when no line does. A message that was the first beat of a quiet run is
 * not first any more once earlier heartbeats join that run, so the id a
 * screen saved before loading them no longer names a row. This returns the
 * id the row has now.
 */
export const findRowIdOfMessage = (
  lines: readonly ConversationLine[],
  messageId: string,
): string | undefined => {
  const line = lines.find((one) =>
    one.kind === "message"
      ? one.message.id === messageId
      : one.run.beats.some((beat) => beat.id === messageId),
  );
  return line === undefined ? undefined : readLineRowId(line);
};
