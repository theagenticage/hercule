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
 * `continuesHeldRows` compares with the row the controller has at that
 * position. Returns undefined when `held` is empty, because then the whole
 * transcript is read.
 */
export const findCatchUpAfterPosition = (held: readonly TranscriptRow[]): number | undefined =>
  held.length === 0 ? undefined : (held.at(-2)?.position ?? 0);

/**
 * Checks that `page`, read with the `after` position `findCatchUpAfterPosition`
 * returned for `held`, continues the rows held: its first row is the last row
 * held, with the same position and the same event id. Returns true when
 * `held` is empty, because there is nothing to continue.
 *
 * It returns false when the controller's log is not the one `held` came from,
 * such as when it was restored from a backup. Its newer rows then sit at the
 * positions the held rows had, or the page is empty because the log is
 * shorter. Merging such a page into `held` would store a transcript that
 * mixes two histories, so the caller reads the whole transcript instead.
 */
export const continuesHeldRows = (
  held: readonly TranscriptRow[],
  page: readonly TranscriptRow[],
): boolean => {
  const last = held.at(-1);
  if (last === undefined) return true;
  const first = page[0];
  return (
    first !== undefined &&
    first.position === last.position &&
    first.event.eventId === last.event.eventId
  );
};
