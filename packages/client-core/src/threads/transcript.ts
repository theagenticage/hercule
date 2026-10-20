/**
 * Merges transcript rows that arrive live into the cached transcript. Returns
 * `current` unchanged when every incoming row is already cached.
 *
 * The transcript log is append-only and ordered by `position`, but deliveries
 * are not ordered: two subscriptions started from the same empty cache both
 * replay from the start of the log, and the later one's rows can arrive first.
 * Merging by `position`, instead of appending, gives the same result in any
 * arrival order. A row whose position is already cached is the same row, so
 * the cached copy is kept.
 */
import type { TranscriptRow } from "@hercule/contract";

export const mergeTranscript = (
  current: readonly TranscriptRow[],
  incoming: readonly TranscriptRow[],
): readonly TranscriptRow[] => {
  const fresh = findNewRows(current, incoming);
  if (fresh.length === 0) return current;
  return [...current, ...fresh].sort((left, right) => left.position - right.position);
};

/**
 * Returns the incoming rows whose position `current` does not hold, in the
 * order they arrived. A caller that keeps state beside the transcript, such
 * as a streaming tail, applies only these, because a replayed row was
 * already applied when it first arrived.
 */
export const findNewRows = (
  current: readonly TranscriptRow[],
  incoming: readonly TranscriptRow[],
): readonly TranscriptRow[] => {
  const held = new Set(current.map((row) => row.position));
  return incoming.filter((row) => !held.has(row.position));
};

/**
 * Returns the `after` position to read the rows written since `held` with:
 * the position of the row before `held`'s last row, or 0 when `held` has one
 * row. The page then starts with the last row held, which
 * `classifyTranscriptPage` compares with the row the controller has at that
 * position. Returns undefined when `held` is empty, because then the whole
 * transcript is read.
 */
export const findTranscriptAfterPosition = (held: readonly TranscriptRow[]): number | undefined =>
  held.length === 0 ? undefined : (held.at(-2)?.position ?? 0);

/** What a page of a transcript read is, compared with the rows held. See `classifyTranscriptPage`. */
export type TranscriptPageKind = "continuesHeldRows" | "wholeTranscript" | "replacedLog";

/**
 * Classifies `page`, a transcript read made with the `after` position
 * `findTranscriptAfterPosition` returned for `held`. Returns:
 * - `wholeTranscript` when `after` is above 0 and the first row is at or below
 *   it. A controller that predates `after` ignores it and answers from the
 *   start of the log, so the page is the whole transcript.
 * - `continuesHeldRows` when the first row is the last row held, with the
 *   same position and event id, or when `held` is empty (there is nothing to
 *   continue). The caller merges the page into `held`.
 * - `replacedLog` otherwise. The controller's log is not the one `held` came
 *   from, such as when it was restored from a backup: its newer rows sit at
 *   the positions the held rows had, or the page is empty because the log is
 *   shorter. Merging such a page into `held` would store a transcript that
 *   mixes two histories, so the caller reads the whole transcript instead.
 */
export const classifyTranscriptPage = (
  held: readonly TranscriptRow[],
  page: readonly TranscriptRow[],
): TranscriptPageKind => {
  const last = held.at(-1);
  if (last === undefined) return "continuesHeldRows";
  const first = page[0];
  if (first === undefined) return "replacedLog";
  const after = findTranscriptAfterPosition(held) ?? 0;
  if (after > 0 && first.position <= after) return "wholeTranscript";
  return first.position === last.position && first.event.eventId === last.event.eventId
    ? "continuesHeldRows"
    : "replacedLog";
};
