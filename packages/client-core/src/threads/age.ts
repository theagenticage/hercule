/**
 * A thread row's age: how long since `at`, read at the coarsest unit that
 * still fits - minutes, then hours, then days, then weeks - because a row is
 * scanned, not read to the second. The instant is a parameter rather than a
 * clock this module reads, so the caller decides what "now" is and a test can
 * pin it.
 */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export const formatAge = (at: string, now: Date): string => {
  const elapsed = Math.max(0, now.getTime() - Date.parse(at));

  if (elapsed < MINUTE_MS) return "now";
  if (elapsed < HOUR_MS) return `${String(Math.floor(elapsed / MINUTE_MS))}m`;
  if (elapsed < DAY_MS) return `${String(Math.floor(elapsed / HOUR_MS))}h`;
  if (elapsed < WEEK_MS) return `${String(Math.floor(elapsed / DAY_MS))}d`;
  return `${String(Math.floor(elapsed / WEEK_MS))}w`;
};
