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
  const other =
    sameDayAs === undefined ? undefined : buildPartReader("precise", sameDayAs, timezone);
  const isSameDay =
    other !== undefined &&
    (["year", "month", "day"] as const).every((type) => other(type) === part(type));
  return isSameDay ? time : `${day} ${part("month")} ${time}`;
};

/** Formats the time context as the moment a screen counts from: "since Sunday 22:10". */
export const formatSince = (instant: Date, timezone: string): string | undefined => {
  const reading = formatTimeContext(instant, timezone);
  return reading === undefined ? undefined : `since ${reading}`;
};
