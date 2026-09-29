/**
 * Formats a thread row's age: the time since `at`, in the largest unit that
 * fits (minutes, hours, days or weeks), because a row is scanned, not read to
 * the second. `now` is a parameter rather than a clock this module reads, so
 * the caller decides what "now" is and a test can fix it.
 *
 * The short form (`formatAge`) is what a row shows; the long form
 * (`describeAge`) is what a screen reader says. Both count the same age, so
 * they always change at the same moment, and `findNextAgeChange` finds that
 * moment for both.
 */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/**
 * The unit an age is counted in: its length, the letter the short form writes
 * after the number, and the word the long form writes.
 */
interface AgeUnit {
  readonly ms: number;
  readonly suffix: string;
  readonly word: string;
}

/** An age: how many whole units have passed, and which unit they are. */
interface Age {
  readonly count: number;
  readonly unit: AgeUnit;
}

/**
 * Returns the unit an elapsed time is counted in: the largest that fits.
 * Anything under an hour is counted in minutes, including the first minute,
 * whose count is 0.
 */
const pickAgeUnit = (elapsed: number): AgeUnit => {
  if (elapsed < HOUR_MS) return { ms: MINUTE_MS, suffix: "m", word: "minute" };
  if (elapsed < DAY_MS) return { ms: HOUR_MS, suffix: "h", word: "hour" };
  if (elapsed < WEEK_MS) return { ms: DAY_MS, suffix: "d", word: "day" };
  return { ms: WEEK_MS, suffix: "w", word: "week" };
};

/**
 * Returns the age of `at` seen from `now`. An `at` later than `now` counts as
 * no time at all, so an age is never negative.
 */
const measureAge = (at: string, now: Date): Age => {
  const elapsed = Math.max(0, now.getTime() - Date.parse(at));
  const unit = pickAgeUnit(elapsed);
  return { count: Math.floor(elapsed / unit.ms), unit };
};

/** Returns the time from `at` to `now`, such as "now", "5m", "3h", "2d" or "1w". */
export const formatAge = (at: string, now: Date): string => {
  const { count, unit } = measureAge(at, now);
  return count === 0 ? "now" : `${String(count)}${unit.suffix}`;
};

/**
 * Returns the time from `at` to `now` in words, such as "just now",
 * "1 minute ago", "20 minutes ago" or "3 weeks ago", for a screen reader to
 * say where a row shows `formatAge`.
 */
export const describeAge = (at: string, now: Date): string => {
  const { count, unit } = measureAge(at, now);
  if (count === 0) return "just now";
  return `${String(count)} ${unit.word}${count === 1 ? "" : "s"} ago`;
};

/**
 * Returns the first moment after `now` at which `formatAge(at, ·)` and
 * `describeAge(at, ·)` return a different string, such as the moment "4m"
 * turns into "5m", or "59m" into "1h". A screen that shows ages sets one timer
 * for that moment instead of waking every second to check.
 *
 * The moment can be far away. An `at` later than `now`, which happens when
 * two machines' clocks disagree, reads "now" until one minute after `at`, and
 * that can be more than 2,147,483,647 ms (about 24.8 days) from `now`.
 * `setTimeout` runs a longer delay after 1 ms instead of waiting, so a caller
 * that passes the delay to `setTimeout` must clamp it to 2,147,483,647 ms, or
 * its timer fires over and over.
 */
export const findNextAgeChange = (at: string, now: Date): Date => {
  const { count, unit } = measureAge(at, now);
  return new Date(Date.parse(at) + (count + 1) * unit.ms);
};
