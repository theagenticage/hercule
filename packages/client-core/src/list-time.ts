/**
 * Formats the times in a list's time column, the way a mail app dates its
 * rows ("10:31", "Sun", "1 Oct"), and finds when such a text must be read
 * again. The workflow list is the one screen that shows them.
 *
 * This module is the subpath `@hercule/client-core/list-time`, not part of
 * the index, so that its code stays off the desktop app's first screen: it
 * loads in the chunk of the Workflows route, which imports it.
 */
import { buildPartReader, computeMinutesOfDay, formatDay, readCalendarDate } from "./time-context";

/** The length of a minute, in milliseconds. */
const MINUTE_MS = 60_000;

/**
 * Returns the moment the clock in `timezone` read 00:00 on the date it reads
 * at `instant`, or the first moment of that date when the clock skipped
 * 00:00. Returns `undefined` in the same cases as `formatTimeContext`.
 *
 * It goes back from `instant` by the minutes the clock shows. That lands on
 * 00:00 unless the clock moved for daylight saving time in between, in which
 * case it lands an hour or so off and corrects by its own reading:
 *
 * - on the same date, it goes back by the minutes it reads;
 * - on the date before, it goes forward to the end of that date.
 */
const findClockMidnight = (instant: Date, timezone: string): Date | undefined => {
  const date = readCalendarDate(instant, timezone);
  const minutes = computeMinutesOfDay(instant, timezone);
  if (date === undefined || minutes === undefined) return undefined;

  const guess = new Date(
    Math.floor(instant.getTime() / MINUTE_MS) * MINUTE_MS - minutes * MINUTE_MS,
  );
  const guessDate = readCalendarDate(guess, timezone);
  const guessMinutes = computeMinutesOfDay(guess, timezone);
  if (guessDate === undefined || guessMinutes === undefined) return undefined;
  const correction = guessDate.dayNumber === date.dayNumber ? -guessMinutes : 1440 - guessMinutes;
  return new Date(guess.getTime() + correction * MINUTE_MS);
};

/**
 * Returns the first moment of the calendar date `instant` falls on in
 * `timezone`. Returns `undefined` in the same cases as `formatTimeContext`.
 *
 * The steps:
 *
 * 1. Find the moment the clock read 00:00 on that date (`findClockMidnight`).
 *    On a date whose clock skips 00:00, this is the date's first moment.
 * 2. Look at the minute before it. When that minute falls on the same date,
 *    the clock went back across midnight, as it does in Havana when daylight
 *    saving time ends at 01:00, and read 00:00 once before. Find that earlier
 *    00:00 from the minute before, and look again.
 * 3. Once the minute before falls on the date before, the date starts here.
 */
export const computeDayStart = (instant: Date, timezone: string): Date | undefined => {
  const date = readCalendarDate(instant, timezone);
  let start = findClockMidnight(instant, timezone);
  if (date === undefined || start === undefined) return undefined;
  for (;;) {
    const minuteBefore = new Date(start.getTime() - MINUTE_MS);
    if (readCalendarDate(minuteBefore, timezone)?.dayNumber !== date.dayNumber) return start;
    const earlier = findClockMidnight(minuteBefore, timezone);
    if (earlier === undefined) return undefined;
    start = earlier;
  }
};

/**
 * Formats an instant for a list's time column, the way a mail app dates its
 * rows, in `timezone` and relative to `now`:
 *
 * - "10:31" on the date of `now`;
 * - within the six dates before `now` (`past`), the weekday alone: "Sun",
 *   because how old a row is matters more than the minute;
 * - within the six dates after `now` (`future`), the weekday and the time:
 *   "Fri 14:00", because a schedule fires at a time;
 * - otherwise the date, "1 Oct", with the year when it is not the year of
 *   `now`: "1 Oct 2025".
 *
 * The text depends on `now` only through the date of `now`, so it changes at
 * local midnight and at no other moment (see `findNextListTimeChange`).
 * Returns `undefined` when either instant is not a valid date or the zone
 * cannot be formatted.
 */
export const formatListTime = (
  instant: Date,
  timezone: string,
  now: Date,
  direction: "past" | "future",
): string | undefined => {
  const date = readCalendarDate(instant, timezone);
  const today = readCalendarDate(now, timezone);
  const clock = buildPartReader("clock", instant, timezone);
  const weekday = buildPartReader("weekday", instant, timezone);
  const day = formatDay(instant, timezone);
  if (
    date === undefined ||
    today === undefined ||
    clock === undefined ||
    weekday === undefined ||
    day === undefined
  ) {
    return undefined;
  }

  const time = `${clock("hour")}:${clock("minute")}`;
  const days =
    direction === "past" ? today.dayNumber - date.dayNumber : date.dayNumber - today.dayNumber;
  if (days === 0) return time;
  if (days > 0 && days < 7) {
    return direction === "past" ? weekday("weekday") : `${weekday("weekday")} ${time}`;
  }
  return date.year === today.year ? day : `${day} ${String(date.year)}`;
};

/** The latest moment a `Date` can hold, for a text that never changes. */
const LAST_MOMENT = new Date(8.64e15);

/**
 * Returns the first moment after `now` at which a list time column showing
 * `instant` must be read again:
 *
 * - the start of the next date in `timezone`, when `formatListTime`'s text
 *   moves on, such as "10:31" turning into "Sun";
 * - for `future`, the instant itself when it comes sooner. The text does not
 *   change then, but the time it names has passed, so the Next column, which
 *   names a trigger's next fire, is read again at that moment (spec 17
 *   §Workflows, "Times read the age clock").
 *
 * The next date is found from the start of today and 36 hours on: a day is
 * 23 to 25 hours long when the clock moves for daylight saving time, so 36
 * hours past the start of one date always falls on the next date, never the
 * one after.
 *
 * Returns the latest moment a `Date` can hold when the zone or either
 * instant is invalid, because `formatListTime` then returns `undefined`
 * forever. A caller passing the delay to `setTimeout` must clamp it, as the
 * age clock does.
 */
export const findNextListTimeChange = (
  instant: Date,
  timezone: string,
  now: Date,
  direction: "past" | "future",
): Date => {
  const todayStart = computeDayStart(now, timezone);
  const tomorrowStart =
    todayStart === undefined
      ? undefined
      : computeDayStart(new Date(todayStart.getTime() + 36 * 3_600_000), timezone);
  if (tomorrowStart === undefined || Number.isNaN(instant.getTime())) return LAST_MOMENT;
  return direction === "future" &&
    instant.getTime() > now.getTime() &&
    instant.getTime() < tomorrowStart.getTime()
    ? instant
    : tomorrowStart;
};
