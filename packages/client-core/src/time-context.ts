/**
 * The time context the top bar carries beside the screen title: "Monday 09:14",
 * and "since Sunday 22:10" where a screen is framed on when the user last
 * looked.
 *
 * Both readings are in the user's timezone, the one timezone source, and both
 * are 24-hour. The instant is a parameter rather than a clock this module
 * reads, so the caller decides what "now" is and a test can pin it.
 */

/** Weekday and 24-hour clock time, in the zone given: "Monday 09:14". */
export const formatTimeContext = (instant: Date, timezone: string): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);

  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";

  return `${part("weekday")} ${part("hour")}:${part("minute")}`;
};

/** The same reading, framed as the moment a screen counts from. */
export const formatSince = (instant: Date, timezone: string): string =>
  `since ${formatTimeContext(instant, timezone)}`;
