/**
 * Formats times for display: the time context the top bar shows beside the
 * screen title ("Monday 09:14", or "since Sunday 22:10" on a screen that
 * counts from when the user last looked), and the stamp beside a record.
 *
 * Every format uses the user's timezone setting and a 24-hour clock. The
 * instant is a parameter rather than a clock this module reads, so the caller
 * decides what "now" is and a test can fix it.
 *
 * No function here throws. An invalid date or a zone this runtime cannot
 * format returns `undefined`, because there is nothing correct to show. The
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
const buildPartReader = (
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
 * Computes the first instant of the calendar day `instant` falls on in
 * `timezone`: its midnight, or the first instant the date has on a date whose
 * clock skips midnight for daylight saving time. Returns `undefined` in the
 * same cases as `formatTimeContext`.
 *
 * Going back by the clock's reading lands on midnight unless the clock moved
 * since then. When it moved, the first guess reads an hour or so off, and is
 * corrected by its own reading: back to midnight when it fell on the same
 * date, forward to the date's first instant when it fell on the date before.
 */
export const computeDayStart = (instant: Date, timezone: string): Date | undefined => {
  const date = readCalendarDate(instant, timezone);
  const minutes = computeMinutesOfDay(instant, timezone);
  if (date === undefined || minutes === undefined) return undefined;

  const guess = new Date(Math.floor(instant.getTime() / 60_000) * 60_000 - minutes * 60_000);
  const guessDate = readCalendarDate(guess, timezone);
  const guessMinutes = computeMinutesOfDay(guess, timezone);
  if (guessDate === undefined || guessMinutes === undefined) return undefined;
  const correction = guessDate.dayNumber === date.dayNumber ? -guessMinutes : 1440 - guessMinutes;
  return new Date(guess.getTime() + correction * 60_000);
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
const readCalendarDate = (
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
