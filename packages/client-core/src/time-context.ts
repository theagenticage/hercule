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
 */

/**
 * Weekday and 24-hour clock time, in the zone given: "Monday 09:14". Nothing,
 * when the instant is not a date or the zone cannot be formatted.
 */
export const formatTimeContext = (instant: Date, timezone: string): string | undefined => {
  let parts: readonly Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
  } catch {
    return undefined;
  }

  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";

  return `${part("weekday")} ${part("hour")}:${part("minute")}`;
};

/**
 * A moment as a stamp beside a record: "4 Sep 17:21". The year is left off
 * because these sit in lists that are read in the present; the zone and the
 * 24-hour clock are the same ones every other reading uses.
 */
export const formatStamp = (instant: Date, timezone: string): string | undefined => {
  let parts: readonly Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
  } catch {
    return undefined;
  }

  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";

  const day = part("day");
  if (day === "") return undefined;
  return `${day} ${part("month")} ${part("hour")}:${part("minute")}`;
};

/** The same reading, framed as the moment a screen counts from. */
export const formatSince = (instant: Date, timezone: string): string | undefined => {
  const reading = formatTimeContext(instant, timezone);
  return reading === undefined ? undefined : `since ${reading}`;
};
