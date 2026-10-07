/**
 * An assistant's heartbeat schedule as Settings > Assistants shows it: an
 * interval and a window of hours, read from and written back to the
 * five-field cron expression the contract stores, and the day's timeline the
 * section draws from them.
 */
import * as Cron from "effect/Cron";
import * as Result from "effect/Result";
import { computeMinutesOfDay } from "../time-context";
import { findTimeOfDayError, formatTimeOfDay, parseTimeOfDay } from "../time-of-day";
import { isSupportedTimezone, resolveDisplayTimezone } from "../timezone";
import { addStoredChoice } from "./choices";

/**
 * A heartbeat that beats every `intervalHours` hours, at `minute` past the
 * hour, from `fromHour` to `toHour` in the schedule's time zone.
 *
 * Both ends are beats: "every 1 h from 07:00 to 23:00" beats at 07:00 and at
 * 23:00. A window whose `toHour` is smaller than its `fromHour` crosses
 * midnight. `toHour` is always a beat, so the window's length is a whole
 * number of intervals; `fitHeartbeatWindow` makes it so after an edit. A
 * window whose `fromHour` equals its `toHour` beats once a day, whatever its
 * interval; `parseHeartbeatWindow` reads one with an interval of 24 hours,
 * and the edits below never make one with a shorter interval.
 */
export interface HeartbeatWindow {
  readonly intervalHours: number;
  readonly minute: number;
  readonly fromHour: number;
  readonly toHour: number;
}

/** The number of hours in a day, and the largest interval a window can have. */
const HOURS_PER_DAY = 24;

const MINUTES_PER_DAY = HOURS_PER_DAY * 60;

/**
 * Parses a five-field cron expression as an interval and a window of hours.
 * Returns `null` when the expression is not one: when it names a day of the
 * month, a month or a day of the week, when it beats at more than one minute
 * past the hour, or when its hours are not evenly spaced.
 *
 * The hours are compared as a set, so `0 7-23 * * *`, `0 7,8,...,23 * * *`
 * and `0 7-23/1 * * *` all read as the same window.
 *
 * Some sets of hours fit more than one window. They are read this way:
 * - hours that fill the whole day evenly, such as `0 * * * *` or
 *   `0 0-22/2 * * *`, read from the earliest hour, so the window does not
 *   cross midnight;
 * - two hours read with the shorter of their two gaps as the interval, so
 *   `0 9,17 * * *` is "every 8 h from 09:00 to 17:00", and `0 1,22 * * *`
 *   is "every 3 h from 22:00 to 01:00", across midnight. Two hours 12 hours
 *   apart, such as `0 9,21 * * *`, fill the day evenly and read from the
 *   earlier hour, as above;
 * - a single hour, such as `30 9 * * *`, reads as one beat a day: an
 *   interval of 24 hours from 09:30 to 09:30.
 */
export const parseHeartbeatWindow = (schedule: string): HeartbeatWindow | null => {
  // The parser also accepts a sixth field for seconds, which the contract refuses.
  if (schedule.trim().split(/\s+/).length !== 5) return null;
  const parsed = Cron.parse(schedule);
  if (Result.isFailure(parsed)) return null;
  const cron = parsed.success;
  // The parser returns an empty set for a field written as `*`.
  if (cron.days.size > 0 || cron.months.size > 0 || cron.weekdays.size > 0) return null;
  if (cron.minutes.size !== 1) return null;
  const [minute] = cron.minutes;
  const hours =
    cron.hours.size === 0
      ? Array.from({ length: HOURS_PER_DAY }, (_, hour) => hour)
      : [...cron.hours].sort((a, b) => a - b);
  const window = findHourProgression(hours);
  return window === null ? null : { ...window, minute: minute! };
};

/**
 * Returns the interval and the first and last hour of the evenly spaced
 * hours in `hours`, sorted ascending, allowing the hours to wrap past
 * midnight. Returns `null` when the hours are not evenly spaced.
 *
 * The gaps between neighbouring hours are measured around the clock, the
 * last one from the latest hour to the earliest hour of the next day. In a
 * window every gap is the interval except the one from the window's end back
 * to its start, so at most one gap may differ.
 */
const findHourProgression = (
  hours: ReadonlyArray<number>,
): Omit<HeartbeatWindow, "minute"> | null => {
  const first = hours[0]!;
  if (hours.length === 1) return { intervalHours: HOURS_PER_DAY, fromHour: first, toHour: first };
  const gaps = hours.map((hour, index) =>
    index === hours.length - 1 ? first + HOURS_PER_DAY - hour : hours[index + 1]! - hour,
  );
  // With two hours either gap could be the interval. The shorter one is the
  // reading a person would give: 09 and 17 beat every 8 hours, not every 16.
  const intervalHours =
    hours.length === 2
      ? Math.min(...gaps)
      : gaps.find((gap) => gaps.filter((g) => g === gap).length > 1);
  if (intervalHours === undefined) return null;
  const breaks = gaps.flatMap((gap, index) => (gap === intervalHours ? [] : [index]));
  if (breaks.length > 1) return null;
  // With no break the hours fill the day evenly, and the window is read from
  // the earliest hour. Otherwise it ends at the hour before the break.
  const endIndex = breaks[0] ?? hours.length - 1;
  return {
    intervalHours,
    fromHour: hours[(endIndex + 1) % hours.length]!,
    toHour: hours[endIndex]!,
  };
};

/**
 * Builds the five-field cron expression that beats at every beat of
 * `window`, and only then. `parseHeartbeatWindow` reads the result back as
 * the same window, or, for a set of hours that fits more than one window, as
 * the window its docstring names; the beats are the same either way.
 *
 * A window that crosses midnight is written as a list of hours. A step such
 * as `22-23/3,0-4/3` would be wrong, because each range starts its step
 * again at its own first hour. A window whose length is not a whole number
 * of intervals is written as `fitHeartbeatWindow` fits it.
 */
export const buildHeartbeatSchedule = (window: HeartbeatWindow): string => {
  const { intervalHours, minute, fromHour, toHour } = fitHeartbeatWindow(window);
  if (fromHour === toHour) return `${minute} ${fromHour} * * *`;
  if (fromHour > toHour) {
    const beats = listBeatHours({ intervalHours, minute, fromHour, toHour }).sort((a, b) => a - b);
    return `${minute} ${beats.join(",")} * * *`;
  }
  const step = intervalHours === 1 ? "" : `/${intervalHours}`;
  return `${minute} ${fromHour}-${toHour}${step} * * *`;
};

/** The intervals, in hours, the heartbeat's interval select offers. */
const INTERVAL_CHOICES = [1, 2, 3, 4, 6, 8, 12];

/**
 * Returns the intervals, in hours, the heartbeat's select offers, in
 * ascending order. `stored`, the interval of the assistant's schedule, is
 * among them even when the select does not offer it, such as the 24 of a
 * schedule that beats once a day. `null`, for a schedule that is not a
 * window, adds nothing.
 */
export const listHeartbeatIntervalChoices = (stored: number | null): ReadonlyArray<number> =>
  stored === null ? INTERVAL_CHOICES : addStoredChoice(INTERVAL_CHOICES, stored);

/**
 * Returns `window` with its `toHour` moved back to the window's last beat,
 * so the window's length is a whole number of intervals. Every 3 hours from
 * 07 to 23 becomes every 3 hours from 07 to 22. An interval longer than the
 * window leaves one beat, at `fromHour`.
 */
export const fitHeartbeatWindow = (window: HeartbeatWindow): HeartbeatWindow => {
  const beats = listBeatHours(window);
  return { ...window, toHour: beats[beats.length - 1]! };
};

/**
 * Returns the hours `window` beats at, from its first beat to its last: one
 * every `intervalHours` from `fromHour`, up to `toHour` at the latest.
 */
const listBeatHours = (window: HeartbeatWindow): Array<number> => {
  const length = (window.toHour - window.fromHour + HOURS_PER_DAY) % HOURS_PER_DAY;
  return Array.from(
    { length: Math.floor(length / window.intervalHours) + 1 },
    (_, index) => (window.fromHour + index * window.intervalHours) % HOURS_PER_DAY,
  );
};

/**
 * The window a schedule that is not a window, set from the CLI, is replaced
 * with when the user chooses an interval: from 07:00 to 23:00.
 */
const DEFAULT_WINDOW = { minute: 0, fromHour: 7, toHour: 23 };

/** The outcome of an edit to a heartbeat window: the window to save, or why the edit is refused. */
export type HeartbeatWindowEdit =
  { readonly window: HeartbeatWindow; readonly error?: never } | { readonly error: string };

/**
 * Returns `current` with the interval set to `intervalHours`, its end moved
 * back to its last beat. A `current` of `null`, a schedule that is not a
 * window, is replaced with every `intervalHours` from 07:00 to 23:00.
 *
 * An interval under 24 hours never leaves a window with one beat, because
 * such a window can only be widened by editing its end, and its end is its
 * start. The end then moves to 23:00, or, when that still leaves one beat,
 * to the hour before the start, so the window beats all day. So "once a day
 * at 09:00" set to every 3 h becomes every 3 h from 09:00 to 21:00.
 */
export const changeHeartbeatInterval = (
  current: HeartbeatWindow | null,
  intervalHours: number,
): HeartbeatWindow => {
  const base = current ?? DEFAULT_WINDOW;
  const next = fitHeartbeatWindow({ ...base, intervalHours });
  if (intervalHours >= HOURS_PER_DAY || next.fromHour !== next.toHour) return next;
  const widened = fitHeartbeatWindow({ ...next, toHour: 23 });
  if (widened.fromHour !== widened.toHour) return widened;
  return fitHeartbeatWindow({
    ...next,
    toHour: (next.fromHour + HOURS_PER_DAY - 1) % HOURS_PER_DAY,
  });
};

/**
 * Returns `current` with its start moved to `text`, a time of day such as
 * "08:30", and its end moved back to its last beat. The schedule beats at
 * one minute past the hour, so the start's minute becomes the minute of
 * every beat. A window with one beat a day moves its only beat.
 *
 * Refuses, with an error that says why and what to write instead:
 * - text that is not a time of day;
 * - a start that leaves the window one beat a day;
 * - a start that makes the window beat all day, unless it already did.
 */
export const moveHeartbeatStart = (current: HeartbeatWindow, text: string): HeartbeatWindowEdit => {
  const time = parseTimeOfDay(text);
  if (time === null) return { error: findTimeOfDayError(text)! };
  if (current.fromHour === current.toHour) {
    return { window: { ...current, fromHour: time.hour, toHour: time.hour, minute: time.minute } };
  }
  const window = fitHeartbeatWindow({ ...current, fromHour: time.hour, minute: time.minute });
  const end = formatTimeOfDay(current.toHour, time.minute);
  if (window.fromHour === window.toHour) {
    return {
      error: `A start at ${text} leaves one beat a day before the window ends at ${end}. Start at least ${String(current.intervalHours)} h before ${end}.`,
    };
  }
  if (fillsDay(window) && !fillsDay(current)) {
    return {
      error: `A start at ${text} runs the window past midnight to ${end}, so it beats all day. Start before ${end}, or move the end first.`,
    };
  }
  return { window };
};

/**
 * Returns `current` with its end moved to `text`, a time of day such as
 * "22:00".
 *
 * Refuses, with an error that says why and what to write instead:
 * - text that is not a time of day;
 * - an end at another minute past the hour than the start, because every
 *   beat is at the same minute;
 * - an end that is not a beat, naming the last beat before it;
 * - an end at the start, which would leave one beat a day.
 */
export const moveHeartbeatEnd = (current: HeartbeatWindow, text: string): HeartbeatWindowEdit => {
  const time = parseTimeOfDay(text);
  if (time === null) return { error: findTimeOfDayError(text)! };
  const start = formatTimeOfDay(current.fromHour, current.minute);
  if (time.minute !== current.minute) {
    return {
      error: `The window ends at the same minute past the hour as it starts, so write ${formatTimeOfDay(time.hour, current.minute)}. To change the minute, change the start.`,
    };
  }
  if (time.hour === current.fromHour && current.fromHour !== current.toHour) {
    return {
      error: `An end at ${text} is the start, which leaves one beat a day. To beat once a day, choose a 24 h interval.`,
    };
  }
  const window = { ...current, toHour: time.hour };
  const lastBeat = fitHeartbeatWindow(window).toHour;
  if (lastBeat !== time.hour) {
    return {
      error: `A beat every ${String(current.intervalHours)} h from ${start} does not land on ${text}. The last beat before it is at ${formatTimeOfDay(lastBeat, current.minute)}.`,
    };
  }
  return { window };
};

/**
 * Checks whether `window`, already fitted, has more than one beat and beats
 * around the whole day: the gap from its last beat to its next first beat is
 * no longer than its interval.
 */
const fillsDay = (window: HeartbeatWindow): boolean => {
  const beats = listBeatHours(window);
  return beats.length > 1 && beats.length * window.intervalHours >= HOURS_PER_DAY;
};

/** One label on the timeline's axis. `at` is a share of the day, from 0 at midnight to 1. */
interface HeartbeatDayLabel {
  readonly at: number;
  /** The hour as two digits, such as "07", or "now". */
  readonly text: string;
}

/**
 * The day's timeline of a heartbeat window, as Settings > Assistants draws
 * it. Every place is a share of the day, from 0 at midnight to 1 at the next
 * midnight.
 */
interface HeartbeatDay {
  /**
   * The window's spans: one, or two when the window crosses midnight. A window
   * that crosses midnight and ends at 00:00 has one.
   */
  readonly spans: ReadonlyArray<{ readonly from: number; readonly to: number }>;
  /**
   * One tick per beat, in order. A tick starts at its beat, except at the end
   * of a span, where it would fall outside the window: there `atEnd` is true
   * and the tick ends at its beat.
   */
  readonly beats: ReadonlyArray<{ readonly at: number; readonly atEnd: boolean }>;
  readonly now: number;
  /** The axis's labels, left to right, none so close to another that the two would overlap. */
  readonly labels: ReadonlyArray<HeartbeatDayLabel>;
}

/**
 * The closest an axis label for 00, 12 or 18 may sit to the window's labels
 * or to "now", as a share of the day: an hour and a half. A closer label
 * would overlap them at the width the settings page draws the timeline.
 */
const FIXED_LABEL_CLEARANCE = 1.5 / HOURS_PER_DAY;

/**
 * The closest a window label may sit to "now" or to the window's other
 * label, as a share of the day: an hour. A closer label would overlap the
 * one already placed at the width the settings page draws the timeline.
 */
const WINDOW_LABEL_CLEARANCE = 1 / HOURS_PER_DAY;

/** The hours the axis labels whenever there is room, as the Bureau book draws it. */
const FIXED_LABEL_HOURS = [0, 12, 18];

/**
 * Builds the timeline of `window` on one day, with the "now" line at
 * `nowMinutes`, the minutes since midnight in the schedule's time zone.
 *
 * A beat at midnight that no span starts at closes a window that ends at
 * 00:00, so its tick is placed at the end of the day, not the start.
 *
 * The axis labels "now", and the window's first and last beat with their
 * hour where each is at least an hour from the labels before it. It adds 00,
 * 12 and 18 where each is at least an hour and a half from those labels.
 */
export const buildHeartbeatDay = (window: HeartbeatWindow, nowMinutes: number): HeartbeatDay => {
  const placeBeat = (hour: number): number => (hour * 60 + window.minute) / MINUTES_PER_DAY;
  const from = placeBeat(window.fromHour);
  const to = placeBeat(window.toHour);
  const now = nowMinutes / MINUTES_PER_DAY;
  // A window that crosses midnight and ends at 00:00 has no span before its
  // last beat, so the empty span is left out.
  const spans =
    window.fromHour > window.toHour
      ? [
          { from: 0, to },
          { from, to: 1 },
        ].filter((span) => span.to > span.from)
      : [{ from, to }];
  const beats = listBeatHours(window)
    .map(placeBeat)
    .map((at) =>
      at === 0 && spans.every((span) => span.from !== 0)
        ? { at: 1, atEnd: true }
        : { at, atEnd: spans.some((span) => span.to === at) },
    )
    .sort((a, b) => a.at - b.at);

  const labels: Array<HeartbeatDayLabel> = [{ at: now, text: "now" }];
  for (const hour of [window.fromHour, window.toHour]) {
    const at = placeBeat(hour);
    if (labels.every((label) => Math.abs(label.at - at) >= WINDOW_LABEL_CLEARANCE)) {
      labels.push({ at, text: formatHour(hour) });
    }
  }
  const placed = [...labels];
  for (const hour of FIXED_LABEL_HOURS) {
    const at = hour / HOURS_PER_DAY;
    if (placed.every((label) => Math.abs(label.at - at) >= FIXED_LABEL_CLEARANCE)) {
      labels.push({ at, text: formatHour(hour) });
    }
  }
  return { spans, beats, now, labels: labels.sort((a, b) => a.at - b.at) };
};

/** Formats an hour of the day as two digits, such as "07". */
const formatHour = (hour: number): string => String(hour).padStart(2, "0");

/**
 * Computes where the timeline's "now" line goes at `at`: the minutes since
 * midnight in the heartbeat's zone, else the user's zone.
 *
 * Returns the zone used, and `unknownTimezone`, the zone asked for when this
 * runtime does not know it, else `null`. In that case the minutes are read
 * in UTC, and the section says so, because the line would otherwise sit at
 * the wrong hour with nothing to explain it.
 */
export const computeHeartbeatNow = (
  at: Date,
  heartbeatTimezone: string | undefined,
  userTimezone: string | undefined,
): {
  readonly nowMinutes: number;
  readonly timezone: string;
  readonly unknownTimezone: string | null;
} => {
  const wanted = heartbeatTimezone ?? userTimezone;
  const timezone = resolveDisplayTimezone(wanted);
  return {
    // The zone is one this runtime formats, and `at` is a valid date.
    nowMinutes: computeMinutesOfDay(at, timezone)!,
    timezone,
    unknownTimezone: wanted !== undefined && !isSupportedTimezone(wanted) ? wanted : null,
  };
};
