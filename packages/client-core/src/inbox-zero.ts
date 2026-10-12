import {
  computeNextMidnight,
  computeWeekday,
  computeZonedInstant,
  readWallClock,
  type WallClock,
} from "./time-context";

/** The line under "Inbox zero", and when it next may read differently. */
export interface InboxZeroLine {
  readonly text: string;
  /** The next of 12:00, 18:00 and midnight after `now`, when the line is worked out again. */
  readonly changesAt: Date;
}

/**
 * Describes the line inbox zero shows under its heading, for `now` in
 * `timezone`, the user's timezone setting (spec 17 §Motion):
 *
 * - "Nothing needs you this weekend." all day on Saturday and Sunday;
 * - "Have a good weekend." on Friday from 12:00;
 * - "Go home." from 18:00;
 * - "The rest of the afternoon is yours." from 12:00;
 * - "The rest of the morning is yours." before 12:00.
 *
 * Also returns when the line should be worked out again: the next of 12:00,
 * 18:00 and midnight. A zone this runtime cannot read, which
 * `resolveDisplayTimezone` never returns, gives the morning's line, worked
 * out again an hour later.
 */
export const describeInboxZeroLine = (now: Date, timezone: string): InboxZeroLine => {
  const clock = readWallClock(now, timezone);
  if (clock === undefined) {
    return {
      text: "The rest of the morning is yours.",
      changesAt: new Date(now.getTime() + 3_600_000),
    };
  }
  const changes = [
    computeZonedInstant(clock, 12, 0, timezone),
    computeZonedInstant(clock, 18, 0, timezone),
    computeNextMidnight(now, timezone)?.getTime(),
  ].filter((instant): instant is number => instant !== undefined && instant > now.getTime());
  return {
    text: chooseLineText(clock),
    // A day can have no midnight after it: Samoa skipped 30 December 2011
    // whole. A day later is then the time to work the line out again.
    changesAt: new Date(Math.min(...changes, now.getTime() + 86_400_000)),
  };
};

/** Returns the line's text for the date and time `clock` reads, by the rules on `describeInboxZeroLine`. */
const chooseLineText = (clock: WallClock): string => {
  const weekday = computeWeekday(clock);
  if (weekday === 0 || weekday === 6) return "Nothing needs you this weekend.";
  if (weekday === 5 && clock.hour >= 12) return "Have a good weekend.";
  if (clock.hour >= 18) return "Go home.";
  if (clock.hour >= 12) return "The rest of the afternoon is yours.";
  return "The rest of the morning is yours.";
};
