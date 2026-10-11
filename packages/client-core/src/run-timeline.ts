/**
 * The Runs tab's timeline: one day of a workflow's runs across its hours
 * (spec 17 §Workflows, "The open workflow", "The timeline").
 *
 * A place across the day is a fraction of its length in real time: 0 at its
 * first instant, 1 at the next day's. A day on which the clock moves for
 * daylight saving time is 23 or 25 hours long, so its hour lines are not
 * evenly spread over 24 labels: one hour has no line, or one has two.
 *
 * Only the now line depends on the time. The bars, their tracks, the hour
 * lines and the fires to come are built without it, so they stay equal as
 * time passes. The screen reads the time on the age clock once a minute
 * (`findNextTimelineMinute`), and draws the now line, and the end of every
 * live run's bar, at `locateTimelineNow`. On the day timeline a pixel is
 * about two minutes, so a minute is as fine as the eye can see.
 *
 * This module is the subpath `@hercule/client-core/run-timeline`, not part
 * of the index, so that it stays off the desktop app's first screen.
 */
import type { RunSummary, Trigger, WorkflowDefinition } from "@hercule/contract";
import { computeDayStart } from "./list-time";
import { readTimestamps } from "./run-display";
import {
  addCalendarDays,
  computeMinutesOfDay,
  computeZonedInstant,
  formatClock,
  readWallClock,
  type CalendarDate,
} from "./time-context";
import type { WaitingRunSession } from "./waiting";
import { buildRunRows, type RunRow } from "./workflow-detail-rows";

/** One day, from its first instant up to the next day's. */
export interface TimelineDay {
  readonly start: Date;
  readonly end: Date;
  /** Whether the day is the one the time fell on when it was computed. Only today has a now line. */
  readonly isToday: boolean;
}

/** One hour line, at the start of a local hour. */
export interface TimelineHour {
  /** The line's place across the day. */
  readonly at: number;
  /** When the hour starts, in milliseconds since the epoch. */
  readonly startsAt: number;
  /** The hour as the clock reads it, "06:00". */
  readonly label: string;
  /** Whether the hour is a multiple of three, which a narrow pane labels alone. */
  readonly isMajor: boolean;
}

/** Where the now line is drawn. */
export interface TimelineNow {
  /** The start of the minute the line is drawn at, in milliseconds since the epoch. */
  readonly instant: number;
  /** The line's place across the day. */
  readonly at: number;
  /** The time in the pill, "09:41". */
  readonly text: string;
}

/** One run's bar. */
export interface TimelineBar {
  /** The run, as its row in the Runs tab's list shows it, which gives its mark, tone and words. */
  readonly row: RunRow;
  /**
   * Where the bar starts: when the run started, or when it was created for a
   * run that has not started a step, or 0 when that was on a day before.
   */
  readonly from: number;
  /**
   * Where the bar ends: when the run ended, or 1 when it went on past the
   * day. Null for a live run on today, whose bar ends at the now line.
   */
  readonly to: number | null;
  /** The track the bar is drawn on, 0 for the top one. */
  readonly track: number;
  /** Whether the run started on a day before, so the bar is cut square at the day's start. */
  readonly startsBefore: boolean;
  /**
   * Whether the run went on past the day, so the bar is cut square at the
   * day's end and has no mark: its mark is drawn on the day it ends.
   */
  readonly endsAfter: boolean;
}

/** The bars of one day. */
export interface TimelineBars {
  /** The bars, from the earliest start to the latest. */
  readonly bars: ReadonlyArray<TimelineBar>;
  /** How many tracks the bars take: 0 for a day with no runs. */
  readonly trackCount: number;
}

/** A start trigger's next fire, later today. */
export interface TimelineFire {
  readonly triggerId: string;
  /** The tick's place across the day. */
  readonly at: number;
  /** When it fires, "14:00", drawn beside the tick. */
  readonly text: string;
  /** The tick's title, "on_friday starts a run at 14:00". */
  readonly title: string;
}

const MINUTE = 60_000;

/**
 * The shortest time a bar holds its track for. A run of a few seconds is
 * drawn as its mark alone, and the next run on its track must start clear
 * of that mark, however wide the pane is.
 */
const SHORTEST_TRACK_HOLD = 45 * MINUTE;

/** The time on either side of now whose hour label the now pill covers. */
const NOW_PILL_REACH = 45 * MINUTE;

/** Returns the error for a timezone the platform cannot read. */
const buildUnsupportedTimezoneError = (timezone: string): Error =>
  new Error(`The timezone "${timezone}" is not supported.`);

/**
 * Returns the first instant of `date` in `timezone`, and fails for a zone
 * that cannot be read, or a date the zone's clock skipped.
 *
 * It finds the date's noon first, because no zone moves its clock across
 * noon for daylight saving time, and then the start of the day noon falls on.
 */
const findDateStart = (date: CalendarDate, timezone: string): Date => {
  const noon = computeZonedInstant(date, 12, 0, timezone);
  const start = noon === undefined ? undefined : computeDayStart(new Date(noon), timezone);
  if (start === undefined) {
    throw new Error(
      `The date ${String(date.year)}-${String(date.month)}-${String(date.day)} has no noon in the timezone "${timezone}".`,
    );
  }
  return start;
};

/**
 * The most days back the timeline goes: ten years. The route's search
 * validator refuses a `daysBack` above it, and `computeTimelineDay` clamps
 * to it, so the day is always one the platform's timezone data covers well.
 */
export const MAX_TIMELINE_DAYS_BACK = 3650;

/**
 * Computes the day `daysBack` days before the day `now` falls on in
 * `timezone`: 0 is today and 1 is yesterday. `daysBack` is clamped to the
 * range from 0 to `MAX_TIMELINE_DAYS_BACK`, and `isToday` is read from the
 * clamped value.
 *
 * Days are counted on the calendar, never in hours: today's date in the
 * zone, minus `daysBack` dates, from that date's first instant up to the
 * next date's. A day the clock moves for daylight saving time is then 23 or
 * 25 hours long, and the time taken does not grow with `daysBack`.
 *
 * Fails when `timezone` is not a zone the platform can read; the display
 * timezone is checked when it is saved, so that is a bug.
 */
export const computeTimelineDay = (now: Date, daysBack: number, timezone: string): TimelineDay => {
  const clamped = Math.min(Math.max(daysBack, 0), MAX_TIMELINE_DAYS_BACK);
  const today = readWallClock(now, timezone);
  if (today === undefined) throw buildUnsupportedTimezoneError(timezone);
  const date = addCalendarDays(today, -clamped);
  return {
    start: findDateStart(date, timezone),
    end: findDateStart(addCalendarDays(date, 1), timezone),
    isToday: clamped === 0,
  };
};

/** Returns where `instant`, in milliseconds, falls across `day`: 0 at its start, 1 at its end. */
const placeAcrossDay = (instant: number, day: TimelineDay): number =>
  (instant - day.start.getTime()) / (day.end.getTime() - day.start.getTime());

/**
 * Builds a line for the start of each local hour of `day` after the first,
 * whose line the timeline's edge already draws, read in `timezone`. On the
 * day the clock moves back, the repeated hour has two lines; on the day it
 * moves forward, the skipped hour has none.
 *
 * Each line sits where the clock reads a whole hour, found from the clock
 * itself rather than by adding 60 minutes. Lord Howe Island moves its clock
 * by half an hour, so there an hour after a line can read ":30"; the next
 * whole hour is then 30 minutes on.
 */
export const buildTimelineHours = (
  day: TimelineDay,
  timezone: string,
): ReadonlyArray<TimelineHour> => {
  const hours: TimelineHour[] = [];
  for (let instant = day.start.getTime(); instant < day.end.getTime();) {
    const minutes = computeMinutesOfDay(new Date(instant), timezone);
    if (minutes === undefined) throw buildUnsupportedTimezoneError(timezone);
    const minuteOfHour = minutes % 60;
    if (minuteOfHour === 0 && instant > day.start.getTime()) {
      const hour = minutes / 60;
      hours.push({
        at: placeAcrossDay(instant, day),
        startsAt: instant,
        label: `${String(hour).padStart(2, "0")}:00`,
        isMajor: hour % 3 === 0,
      });
    }
    instant += (60 - minuteOfHour) * MINUTE;
  }
  return hours;
};

/**
 * Returns the start of the minute after `now`, when the now line next moves.
 * The screen passes it to the age clock.
 */
export const findNextTimelineMinute = (now: Date): Date =>
  new Date((Math.floor(now.getTime() / MINUTE) + 1) * MINUTE);

/**
 * Returns where the now line is drawn on `day` for the time `now`, in
 * milliseconds, read in `timezone`: at the start of its minute, so the line
 * moves once a minute. Returns null when `now` is not within `day`, which
 * then has no now line.
 */
export const locateTimelineNow = (
  day: TimelineDay,
  timezone: string,
  now: number,
): TimelineNow | null => {
  if (now < day.start.getTime() || now >= day.end.getTime()) return null;
  const instant = Math.floor(now / MINUTE) * MINUTE;
  return {
    instant,
    at: placeAcrossDay(instant, day),
    text: formatClock(new Date(instant), timezone) ?? "",
  };
};

/** Checks whether the now pill covers the label of `hour`, which is then left out. */
export const isHourLabelCovered = (hour: TimelineHour, now: TimelineNow | null): boolean =>
  now !== null && Math.abs(hour.startsAt - now.instant) < NOW_PILL_REACH;

/**
 * Builds the bars of the runs in `runs` that were live at some moment of
 * `day`, runs of the workflow `definition` describes. `waitingRunSessions`
 * draw a live run as waiting, as in `buildRunRows`.
 *
 * A bar runs from when the run started, or was created when it has not
 * started a step, to when it ended. A run that has not started is drawn too,
 * as a faint dot. Bars are placed on the first track that is free when they
 * start, so runs that overlap stack and the others share the top track. A
 * live run holds its track for as long as it runs, so the tracks do not
 * depend on the time.
 */
export const buildTimelineBars = (
  runs: ReadonlyArray<RunSummary>,
  definition: WorkflowDefinition,
  waitingRunSessions: ReadonlyArray<WaitingRunSession>,
  day: TimelineDay,
): TimelineBars => {
  const dayStart = day.start.getTime();
  const dayEnd = day.end.getTime();
  const rows = buildRunRows(runs, definition, waitingRunSessions);
  const spans = runs.flatMap((run, index) => {
    const { startedAt, finishedAt } = readTimestamps(run);
    const ranFrom = Date.parse(startedAt ?? run.createdAt);
    const ranTo = finishedAt === undefined ? Infinity : Date.parse(finishedAt);
    if (ranFrom >= dayEnd || ranTo < dayStart) return [];
    return [{ row: rows[index]!, ranFrom, ranTo }];
  });

  // When each track is free again, by track.
  const freeFrom: number[] = [];
  const bars = spans
    .toSorted((a, b) => a.ranFrom - b.ranFrom)
    .map(({ row, ranFrom, ranTo }): TimelineBar => {
      const free = freeFrom.findIndex((instant) => instant <= ranFrom);
      const track = free === -1 ? freeFrom.length : free;
      freeFrom[track] = Math.max(ranTo, ranFrom + SHORTEST_TRACK_HOLD);
      // A live run on a day before today went on past it.
      const endsAfter = ranTo > dayEnd && !(day.isToday && ranTo === Infinity);
      return {
        row,
        from: placeAcrossDay(Math.max(ranFrom, dayStart), day),
        to: endsAfter ? 1 : ranTo === Infinity ? null : placeAcrossDay(ranTo, day),
        track,
        startsBefore: ranFrom < dayStart,
        endsAfter,
      };
    });
  return { bars, trackCount: freeFrom.length };
};

/**
 * Builds a tick for each next fire of `triggers`, the workflow's own, that
 * falls on `day` when it is today, with its time read in `timezone`. A
 * paused trigger, a trigger in error, and every trigger while the workflow
 * is disabled (`enabled` false) does not fire, so it has no tick.
 */
export const buildTimelineFires = (
  triggers: ReadonlyArray<Trigger>,
  enabled: boolean,
  day: TimelineDay,
  timezone: string,
): ReadonlyArray<TimelineFire> => {
  if (!enabled || !day.isToday) return [];
  return triggers.flatMap((trigger): TimelineFire[] => {
    const { kind, status, health, nextFireAt } = trigger;
    if (kind !== "start" || status === "paused" || health?.state === "error") return [];
    if (nextFireAt === undefined) return [];
    const fireAt = Date.parse(nextFireAt);
    if (fireAt < day.start.getTime() || fireAt >= day.end.getTime()) return [];
    const text = formatClock(new Date(fireAt), timezone) ?? "";
    return [
      {
        triggerId: trigger.triggerId,
        at: placeAcrossDay(fireAt, day),
        text,
        title: `${trigger.triggerId} starts a run at ${text}`,
      },
    ];
  });
};
