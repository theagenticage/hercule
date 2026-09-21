/**
 * How a transcript cache takes rows that arrive live. The log is append-only
 * and strictly ordered on `position`, but the deliveries are not: two
 * subscriptions seeded from the same empty cache both replay from the start of
 * the log, and the later one's rows can land before the earlier one's. Merging
 * on `position` rather than after whatever the cache last held is what makes
 * the result the same whichever order they arrive in - a row already held is
 * the same row, so the one in hand stands and the rest are placed in order.
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
