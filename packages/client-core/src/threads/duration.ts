/**
 * Returns the number of seconds `formatDuration` shows for `ms`: rounded to
 * the nearest second, and never below zero.
 */
const countWholeSeconds = (ms: number): number => Math.max(0, Math.round(ms / 1000));

/** Seconds in an hour. From this duration on, `formatDuration` leaves the seconds out. */
const HOUR_SECONDS = 3600;

/**
 * Formats a turn's duration, or a live turn's elapsed time, for the thread's
 * "Worked for" and "Working for" dividers: `31s`, `12m 4s`, `1h 4m`. Seconds
 * are dropped once the duration reaches an hour, because at that point they
 * are noise.
 */
export const formatDuration = (ms: number): string => {
  const totalSeconds = countWholeSeconds(ms);
  const hours = Math.floor(totalSeconds / HOUR_SECONDS);
  const minutes = Math.floor((totalSeconds % HOUR_SECONDS) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

/**
 * Returns the first moment after `now` at which
 * `formatDuration(now - Date.parse(since))` returns a different string, such
 * as the moment "12s" turns into "13s", or "1h 4m" into "1h 5m". A screen
 * that counts "Working for 12s" sets one timer for that moment instead of
 * waking at a fixed interval, the way `findNextAgeChange` works for ages.
 *
 * `formatDuration` rounds to the nearest second, so the text changes half a
 * second before each second it shows: under an hour at every second, and from
 * an hour on, when only minutes are shown, at every whole minute. A `since`
 * later than `now` reads "0s" until half a second after `since`.
 */
export const findNextDurationChange = (since: string, now: Date): Date => {
  const start = Date.parse(since);
  const shown = countWholeSeconds(now.getTime() - start);
  const next = shown < HOUR_SECONDS ? shown + 1 : 60 * (Math.floor(shown / 60) + 1);
  return new Date(start + (next - 0.5) * 1000);
};
