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
  const held = new Set(current.map((row) => row.position));
  const fresh = incoming.filter((row) => !held.has(row.position));
  if (fresh.length === 0) return current;
  return [...current, ...fresh].sort((left, right) => left.position - right.position);
};
