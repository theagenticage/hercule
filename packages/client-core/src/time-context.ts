/**
 * Formats times for display: the time context the top bar shows beside the
 * screen title ("Monday 09:14", or "since Sunday 22:10" on a screen that
 * counts from when the user last looked), and the stamp beside a record.
 * Also reads the calendar date and the clock of an instant in a zone, and
 * computes the instant at which a zone's clock reads a given time.
 *
 * Every format uses the user's timezone setting and a 24-hour clock. The
 * instant is a parameter rather than a clock this module reads, so the caller
 * decides what "now" is and a test can fix it.
 *
 * No function here throws. An invalid date or a zone this runtime cannot
 * format returns `undefined`, because there is nothing correct to show or
 * compute. The
 * top bar is on every screen inside the shell, so it must never stop a screen
 * from rendering.
 *
 * A formatter is expensive to build and cheap to reuse, and these functions
 * run once per row per render, so each formatter is built once per zone and
 * cached. In practice there is one zone: the user's.
 */

/** Each format, and the `Intl.DateTimeFormat` options it uses. */
const SHAPES = {
  context: { weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  clock: { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  weekday: { weekday: "long" },
  shortWeekday: { weekday: "short" },
  day: { day: "numeric", month: "short" },
  date: { year: "numeric", month: "numeric", day: "numeric" },
  stamp: {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  },
  precise: {
    year: "numeric",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  },
  wall: {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

type Shape = keyof typeof SHAPES;

/**
 * The formatters built so far, by format and zone. `null` records a zone this
 * runtime rejected, so an unusable zone is not retried for every row.
 */
const held = new Map<string, Intl.DateTimeFormat | null>();

/**
 * Returns the cached formatter for a format and zone, building it on first use,
 * or `null` for an unusable zone.
 */
const buildFormatter = (shape: Shape, timezone: string): Intl.DateTimeFormat | null => {
  const key = `${shape} ${timezone}`;
  const made = held.get(key);
  if (made !== undefined) return made;

  let formatter: Intl.DateTimeFormat | null;
  try {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, ...SHAPES[shape] });
  } catch {
    formatter = null;
  }
  held.set(key, formatter);
  return formatter;
};

/**
 * Returns a function that reads one part of the formatted instant, or
 * `undefined` when the zone or the instant is invalid.
 */
export const buildPartReader = (
  shape: Shape,
  instant: Date,
  timezone: string,
): ((type: Intl.DateTimeFormatPartTypes) => string) | undefined => {
  const formatter = buildFormatter(shape, timezone);
  if (formatter === null) return undefined;

  let parts: readonly Intl.DateTimeFormatPart[];
  try {
    parts = formatter.formatToParts(instant);
  } catch {
    return undefined;
  }
  return (type) => parts.find((candidate) => candidate.type === type)?.value ?? "";
};

/**
 * Formats the weekday and 24-hour time in `timezone`: "Monday 09:14". Returns
 * `undefined` when the instant is not a valid date or the zone cannot be
 * formatted.
 */
export const formatTimeContext = (instant: Date, timezone: string): string | undefined => {
  const part = buildPartReader("context", instant, timezone);
  if (part === undefined) return undefined;
  return `${part("weekday")} ${part("hour")}:${part("minute")}`;
};

/**
 * Computes the minutes since midnight of `instant` in `timezone`: 0 at
 * midnight, 1439 at 23:59. Returns `undefined` when the instant is not a
 * valid date or the zone cannot be formatted.
 */
export const computeMinutesOfDay = (instant: Date, timezone: string): number | undefined => {
  const part = buildPartReader("clock", instant, timezone);
  if (part === undefined) return undefined;
  return Number(part("hour")) * 60 + Number(part("minute"));
};

/**
 * Formats an instant as the stamp shown beside a record: "4 Sep 17:21". The
 * year is left out because these stamps sit in lists of recent records.
 * Returns `undefined` in the same cases as `formatTimeContext`.
 */
export const formatStamp = (instant: Date, timezone: string): string | undefined => {
  const part = buildPartReader("stamp", instant, timezone);
  if (part === undefined) return undefined;

  const day = part("day");
  if (day === "") return undefined;
  return `${day} ${part("month")} ${part("hour")}:${part("minute")}`;
};

/**
 * Returns the time separator to show above each row of a conversation or a
 * transcript, by position: the row's instant formatted by `formatStamp`, or
 * undefined for no separator. A row passes null when it carries no time of
 * its own.
 *
 * A separator equal to the last one shown is left out, so rows from the same
 * minute share one, as in a messenger.
 */
export const chooseStamps = (
  instants: readonly (string | null)[],
  timezone: string,
): readonly (string | undefined)[] => {
  let shown: string | undefined;
  return instants.map((instant) => {
    if (instant === null) return undefined;
    const stamp = formatStamp(new Date(instant), timezone);
    if (stamp === shown) return undefined;
    shown = stamp;
    return stamp;
  });
};

/**
 * Formats the day an instant falls on in `timezone`: "9 Oct". The year is
 * left out for the same reason as in `formatStamp`. Returns `undefined` in the
 * same cases as `formatTimeContext`.
 */
export const formatDay = (instant: Date, timezone: string): string | undefined => {
  const part = buildPartReader("day", instant, timezone);
  if (part === undefined) return undefined;

  const day = part("day");
  if (day === "") return undefined;
  return `${day} ${part("month")}`;
};

/**
 * Formats an instant to the second, for events that are seconds apart, such
 * as when a run started and ended: "4 Sep 17:21:08", or only "17:21:08" when
 * it falls on the same day as `sameDayAs` in `timezone`. Returns `undefined`
 * in the same cases as `formatTimeContext`.
 */
export const formatPreciseStamp = (
  instant: Date,
  timezone: string,
  sameDayAs?: Date,
): string | undefined => {
  const part = buildPartReader("precise", instant, timezone);
  if (part === undefined) return undefined;

  const day = part("day");
  if (day === "") return undefined;
  const time = `${part("hour")}:${part("minute")}:${part("second")}`;
  return sameDayAs !== undefined && isSameDay(instant, sameDayAs, timezone)
    ? time
    : `${day} ${part("month")} ${time}`;
};

/**
 * Checks whether two instants fall on the same calendar day in `timezone`.
 * Returns false when either instant is not a valid date or the zone cannot be
 * formatted, because then there is no day to compare.
 */
export const isSameDay = (a: Date, b: Date, timezone: string): boolean => {
  const partOfA = buildPartReader("precise", a, timezone);
  const partOfB = buildPartReader("precise", b, timezone);
  if (partOfA === undefined || partOfB === undefined || partOfA("day") === "") return false;
  return (["year", "month", "day"] as const).every((type) => partOfA(type) === partOfB(type));
};

/**
 * Returns the calendar date an instant falls on in `timezone`, as the number
 * of days since 1 January 1970: two instants on consecutive dates differ by
 * exactly 1, however long the day between them was. Also returns that date's
 * year. Returns `undefined` in the same cases as `formatTimeContext`.
 */
export const readCalendarDate = (
  instant: Date,
  timezone: string,
): { readonly dayNumber: number; readonly year: number } | undefined => {
  const part = buildPartReader("date", instant, timezone);
  if (part === undefined || part("day") === "") return undefined;
  const year = Number(part("year"));
  const dayNumber = Date.UTC(year, Number(part("month")) - 1, Number(part("day"))) / 86_400_000;
  return { dayNumber, year };
};

/**
 * Formats the day stamp shown above the first message of each day in a
 * conversation, relative to `now` in `timezone`:
 *
 * - "Today" and "Yesterday" for the date of `now` and the date before it;
 * - "4 Sep" for any other date in the year of `now`;
 * - "4 Sep 2025" for a date in another year.
 *
 * Dates are compared as calendar dates in the zone, never by subtracting 24
 * hours, because the day a clock moves for daylight saving time is 23 or 25
 * hours long. Returns `undefined` when either instant is not a valid date or
 * the zone cannot be formatted.
 */
export const formatDayStamp = (instant: Date, timezone: string, now: Date): string | undefined => {
  const date = readCalendarDate(instant, timezone);
  const today = readCalendarDate(now, timezone);
  if (date === undefined || today === undefined) return undefined;
  if (date.dayNumber === today.dayNumber) return "Today";
  if (date.dayNumber === today.dayNumber - 1) return "Yesterday";
  const day = formatDay(instant, timezone);
  if (day === undefined) return undefined;
  return date.year === today.year ? day : `${day} ${String(date.year)}`;
};

/** Formats the time context as the moment a screen counts from: "since Sunday 22:10". */
export const formatSince = (instant: Date, timezone: string): string | undefined => {
  const reading = formatTimeContext(instant, timezone);
  return reading === undefined ? undefined : `since ${reading}`;
};

/** Formats the clock time of an instant in `timezone`: "09:05". Returns `undefined` in the same cases as `formatTimeContext`. */
export const formatClock = (instant: Date, timezone: string): string | undefined => {
  const part = buildPartReader("clock", instant, timezone);
  if (part === undefined || part("hour") === "") return undefined;
  return `${part("hour")}:${part("minute")}`;
};

/**
 * Returns how many calendar days in `timezone` lie between the date of `now`
 * and the date of `instant`: 0 on the same date, 1 for the next date, -1 for
 * the date before. Returns `undefined` in the same cases as
 * `formatTimeContext`.
 */
export const countCalendarDaysBetween = (
  now: Date,
  instant: Date,
  timezone: string,
): number | undefined => {
  const date = readCalendarDate(instant, timezone);
  const today = readCalendarDate(now, timezone);
  return date === undefined || today === undefined ? undefined : date.dayNumber - today.dayNumber;
};

/**
 * Names the date of `instant` as a sentence does, counted in calendar days
 * from `now` in `timezone`:
 *
 * - "today", "tomorrow" and "yesterday", in lower case because the word sits
 *   inside a sentence: "Back today";
 * - the weekday for the other dates up to 7 days ahead or 6 days back:
 *   "Monday";
 * - the date for any other day: "4 Nov".
 *
 * Returns `undefined` in the same cases as `formatTimeContext`.
 */
export const formatRelativeDay = (
  instant: Date,
  now: Date,
  timezone: string,
): string | undefined => {
  const days = countCalendarDaysBetween(now, instant, timezone);
  if (days === undefined) return undefined;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return isWithinAWeek(days)
    ? buildPartReader("weekday", instant, timezone)?.("weekday")
    : formatDay(instant, timezone);
};

/**
 * Checks whether a date `days` from today is named by its weekday: up to 7
 * days ahead, so a snooze to next Monday picked on a Monday reads "Monday",
 * and up to 6 days back, so no weekday names two dates.
 */
const isWithinAWeek = (days: number): boolean => days >= -6 && days <= 7;

/**
 * Formats an instant as a sentence names it, relative to `now` in
 * `timezone`: "today 14:00", "Monday 09:00", "4 Nov 09:00". The day is named
 * as `formatRelativeDay` names it. Returns `undefined` in the same cases as
 * `formatTimeContext`.
 */
export const formatRelativeMoment = (
  instant: Date,
  now: Date,
  timezone: string,
): string | undefined => {
  const day = formatRelativeDay(instant, now, timezone);
  const clock = formatClock(instant, timezone);
  return day === undefined || clock === undefined ? undefined : `${day} ${clock}`;
};

/**
 * Formats an instant as short as the end of a row or a menu item allows,
 * relative to `now` in `timezone`: "14:00" today, "Mon 09:00" on another
 * date within a week, and "4 Nov 09:00" further off. Returns `undefined` in
 * the same cases as `formatTimeContext`.
 */
export const formatShortMoment = (
  instant: Date,
  now: Date,
  timezone: string,
): string | undefined => {
  const days = countCalendarDaysBetween(now, instant, timezone);
  const clock = formatClock(instant, timezone);
  if (days === undefined || clock === undefined) return undefined;
  if (days === 0) return clock;
  const day = isWithinAWeek(days)
    ? buildPartReader("shortWeekday", instant, timezone)?.("weekday")
    : formatDay(instant, timezone);
  return day === undefined ? undefined : `${day} ${clock}`;
};

/** A date on the calendar: the year, the month from 1 to 12, and the day of the month. */
export interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** A date and the time on the clock, as someone in one zone reads an instant. */
export interface WallClock extends CalendarDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/**
 * Reads the date and the clock time of `instant` in `timezone`, on a 24-hour
 * clock. Returns `undefined` in the same cases as `formatTimeContext`.
 */
export const readWallClock = (instant: Date, timezone: string): WallClock | undefined => {
  const part = buildPartReader("wall", instant, timezone);
  if (part === undefined || part("day") === "") return undefined;
  return {
    year: Number(part("year")),
    month: Number(part("month")),
    day: Number(part("day")),
    hour: Number(part("hour")),
    minute: Number(part("minute")),
    second: Number(part("second")),
  };
};

/** Returns the calendar date `days` after `date`, rolling over months and years. */
export const addCalendarDays = (date: CalendarDate, days: number): CalendarDate => {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
};

/** Returns the weekday of a calendar date: 0 for Sunday to 6 for Saturday. */
export const computeWeekday = (date: CalendarDate): number =>
  new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();

/** One day in milliseconds. No daylight saving change falls twice within one day of an instant. */
const DAY_MS = 86_400_000;

/**
 * Returns how far the clock in `timezone` is ahead of UTC at `instant`, in
 * milliseconds, or `undefined` when the zone cannot be read.
 */
const readUtcOffset = (instant: number, timezone: string): number | undefined => {
  const clock = readWallClock(new Date(instant), timezone);
  if (clock === undefined) return undefined;
  const read = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute,
    clock.second,
  );
  return read - instant;
};

/**
 * Computes the instant at which the clock in `timezone` reads `hour:minute`
 * on `date`, in milliseconds since 1970.
 *
 * - When the clock never reads that time on that date, as in the hour
 *   skipped when daylight saving time starts, or the day Samoa skipped in
 *   2011, it returns `undefined`.
 * - When the clock reads it twice, as in the hour repeated when daylight
 *   saving time ends, it returns the later instant: a snooze until 01:30 on
 *   that night then never comes back before the user expects it.
 * - It also returns `undefined` when the zone cannot be read.
 */
export const computeZonedInstant = (
  date: CalendarDate,
  hour: number,
  minute: number,
  timezone: string,
): number | undefined => {
  const asIfUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  // The zone's offset a day before and a day after are the only two offsets
  // the clock can have at the answer, so each gives one candidate. A
  // candidate counts only when the clock reads the asked time at it.
  const matching = [asIfUtc - DAY_MS, asIfUtc + DAY_MS].flatMap((probe) => {
    const offset = readUtcOffset(probe, timezone);
    if (offset === undefined) return [];
    const candidate = asIfUtc - offset;
    const clock = readWallClock(new Date(candidate), timezone);
    const reads =
      clock !== undefined &&
      clock.year === date.year &&
      clock.month === date.month &&
      clock.day === date.day &&
      clock.hour === hour &&
      clock.minute === minute;
    return reads ? [candidate] : [];
  });
  return matching.length === 0 ? undefined : Math.max(...matching);
};

/**
 * Computes the instant the date after the date of `now` starts in
 * `timezone`: its midnight, or 01:00 in a zone whose clock skips midnight on
 * that date for daylight saving time. Returns `undefined` when the zone
 * cannot be read.
 */
export const computeNextMidnight = (now: Date, timezone: string): Date | undefined => {
  const today = readWallClock(now, timezone);
  if (today === undefined) return undefined;
  const tomorrow = addCalendarDays(today, 1);
  const instant =
    computeZonedInstant(tomorrow, 0, 0, timezone) ?? computeZonedInstant(tomorrow, 1, 0, timezone);
  return instant === undefined ? undefined : new Date(instant);
};
