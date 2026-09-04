/**
 * The time context the top bar carries beside the screen title: "Monday 09:14",
 * and "since Sunday 22:10" where a screen is framed on when the user last
 * looked.
 *
 * Both readings are in the user's timezone, the one timezone source, and both
 * are 24-hour. The instant is a parameter rather than a clock this module
 * reads, so the caller decides what "now" is and a test can pin it.
 *
 * Neither reading throws. A marker that is not a date and a zone this runtime
 * cannot format both answer with nothing, because there is nothing truthful to
 * say about either - and the top bar these feed is on every screen inside the
 * shell, so it must never be the reason nothing renders.
 *
 * A formatter is expensive to build and free to reuse, and these readings are
 * asked for once per row per render, so the formatters are built once per zone
 * and held. There are as many of them as there are zones a user picks, which is
 * one.
 */

/** A reading, and the fields it asks the runtime for. */
const SHAPES = {
  context: { weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  stamp: {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

type Shape = keyof typeof SHAPES;

/**
 * The formatters built so far, by shape and zone. `null` records a zone this
 * runtime refused, so a zone that cannot be formatted is not retried per row.
 */
const held = new Map<string, Intl.DateTimeFormat | null>();

const formatterFor = (shape: Shape, timezone: string): Intl.DateTimeFormat | null => {
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

/** The parts of one reading, or nothing when the zone or the instant is not one. */
const partsOf = (
  shape: Shape,
  instant: Date,
  timezone: string,
): ((type: Intl.DateTimeFormatPartTypes) => string) | undefined => {
  const formatter = formatterFor(shape, timezone);
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
 * Weekday and 24-hour clock time, in the zone given: "Monday 09:14". Nothing,
 * when the instant is not a date or the zone cannot be formatted.
 */
export const formatTimeContext = (instant: Date, timezone: string): string | undefined => {
  const part = partsOf("context", instant, timezone);
  if (part === undefined) return undefined;
  return `${part("weekday")} ${part("hour")}:${part("minute")}`;
};

/**
 * A moment as a stamp beside a record: "4 Sep 17:21". The year is left off
 * because these sit in lists that are read in the present; the zone and the
 * 24-hour clock are the same ones every other reading uses.
 */
export const formatStamp = (instant: Date, timezone: string): string | undefined => {
  const part = partsOf("stamp", instant, timezone);
  if (part === undefined) return undefined;

  const day = part("day");
  if (day === "") return undefined;
  return `${day} ${part("month")} ${part("hour")}:${part("minute")}`;
};

/** The same reading, framed as the moment a screen counts from. */
export const formatSince = (instant: Date, timezone: string): string | undefined => {
  const reading = formatTimeContext(instant, timezone);
  return reading === undefined ? undefined : `since ${reading}`;
};
