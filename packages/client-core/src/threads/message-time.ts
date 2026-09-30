/**
 * The times the desktop thread shows, and the lines that hold them: the time
 * under each user bubble, each agent message's meta line, and the note that
 * the thread waits on the user.
 */
import { formatPreciseStamp } from "../time-context";

/**
 * Formats the time a message was sent, to the minute and on a 24-hour clock:
 * "09:04" when `instant` falls on the same day as `now` in `timezone`, else
 * "4 Sep 09:04". Returns `undefined` when the instant is not a valid date or
 * the zone cannot be formatted, like the formats in `time-context`.
 *
 * It removes the seconds from `formatPreciseStamp`, which already decides
 * "the same day" by year, month and day in the zone, so a message from the
 * same date a year ago still shows its day.
 */
export const formatMessageTime = (instant: Date, timezone: string, now: Date): string | undefined =>
  formatPreciseStamp(instant, timezone, now)?.replace(/:\d\d$/, "");

/**
 * Returns an agent message's meta line: `agent`, such as "Claude Code · Opus
 * 5.5", then the message's `time`, such as "09:04". Returns `agent` alone when
 * the time could not be formatted.
 */
export const describeMessageMeta = (agent: string, time: string | undefined): string =>
  time === undefined ? agent : `${agent} · ${time}`;

/**
 * Returns the note that the thread waits on the user, such as "Waiting on you
 * since 09:31 · 10m": `time` is when the Request opened, and `age` is how long
 * ago that was. Leaves out "since" and the time when the time could not be
 * formatted.
 */
export const describeWaitingNote = (time: string | undefined, age: string): string =>
  time === undefined ? `Waiting on you · ${age}` : `Waiting on you since ${time} · ${age}`;
