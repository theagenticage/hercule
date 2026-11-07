/**
 * Formats the age a card on the Overview shows: the time since `at`, counted
 * in whole days, because a card is scanned and a board of hundreds should not
 * redraw its ages every minute. A card is "today" until it is a day old, then
 * "1d" to "13d", then in weeks ("2w"). `now` is a parameter, so the caller
 * decides what "now" is and a test can fix it.
 *
 * This is not the thread rows' age (`threads/age.ts`), which counts minutes
 * and hours. The short form (`formatDeskAge`) is what a card shows, the long
 * form (`describeDeskAge`) is what a screen reader says, and
 * `findNextDeskAgeChange` finds when either changes.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The first whole age in days that is shown in weeks. */
const FIRST_DAY_IN_WEEKS = 14;

/** Returns how many whole days `at` lies before `now`. An `at` after `now` counts as 0. */
const countDays = (at: string, now: Date): number =>
  Math.floor(Math.max(0, now.getTime() - Date.parse(at)) / DAY_MS);

/** Returns the weeks a card of `days` days (14 or more) is shown as: days divided by 7, rounded. */
const countWeeks = (days: number): number => Math.round(days / 7);

/** Returns the time from `at` to `now` as "today", "2d" (up to "13d") or "2w". */
export const formatDeskAge = (at: string, now: Date): string => {
  const days = countDays(at, now);
  if (days < 1) return "today";
  if (days < FIRST_DAY_IN_WEEKS) return `${String(days)}d`;
  return `${String(countWeeks(days))}w`;
};

/**
 * Returns the time from `at` to `now` in words, such as "today", "1 day ago"
 * or "3 weeks ago", for a screen reader to say where a card shows
 * `formatDeskAge`.
 */
export const describeDeskAge = (at: string, now: Date): string => {
  const days = countDays(at, now);
  if (days < 1) return "today";
  const [count, word] =
    days < FIRST_DAY_IN_WEEKS ? [days, "day"] : ([countWeeks(days), "week"] as const);
  return `${String(count)} ${word}${count === 1 ? "" : "s"} ago`;
};

/**
 * Returns the first moment after `now` at which `formatDeskAge(at, ·)` and
 * `describeDeskAge(at, ·)` return a different string, so a screen sets one
 * timer for it. Up to 13 days that is the next whole day. After that it is
 * the day on which the rounded weeks go up: week `w` lasts until day
 * `7w + 4`.
 *
 * An `at` later than `now` reads "today" until a day after `at`, which can be
 * more than 2,147,483,647 ms (about 24.8 days) from `now`. A caller that gives
 * the delay to `setTimeout` must clamp it, as `findNextAgeChange` says.
 */
export const findNextDeskAgeChange = (at: string, now: Date): Date => {
  const days = countDays(at, now);
  const nextDays = days < FIRST_DAY_IN_WEEKS ? days + 1 : 7 * countWeeks(days) + 4;
  return new Date(Date.parse(at) + nextDays * DAY_MS);
};
