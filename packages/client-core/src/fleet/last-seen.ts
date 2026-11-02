import type { Runner } from "@hercule/contract";
import { formatShortMoment } from "../time-context";

/**
 * Formats when the runner was last heard from, as short as a card allows
 * ("09:12" today, "Mon 09:12" within a week, "4 Nov 09:12" before that), in
 * `timezone` and relative to `now`. Returns `null` when the runner was never
 * seen or the time cannot be formatted.
 *
 * The Fleet cards and a machine's page both word a machine that is away, so
 * they share this one function.
 */
export const formatLastSeen = (runner: Runner, timezone: string, now: Date): string | null => {
  if (runner.lastSeenAt === null) return null;
  return formatShortMoment(new Date(runner.lastSeenAt), now, timezone) ?? null;
};
