/**
 * PROTOTYPE. Decides what the Runs tab's timeline draws for one day of a
 * workflow: a bar for each run that ran that day, packed into tracks so no
 * two bars touch, the day's hour lines, where now is, and when the
 * workflow's start triggers fire next. The Workflows ticket moves it into
 * `@hercule/client-core`, beside the run rows.
 *
 * A place across the day is a fraction of its length in real time: 0 at its
 * first instant, 1 at the next day's. A day the clock moves for daylight
 * saving time is 23 or 25 hours long, so its hour lines are not evenly
 * spread over the day's 24 labels: one hour has no line, or one has two.
 */
import {
  computeDayStart,
  computeMinutesOfDay,
  formatDayStamp,
  readTimestamps,
} from "@hercule/client-core";
import type { RunSummary, Session, Trigger, WorkflowDefinition } from "@hercule/contract";
import { buildRunRow, type RunRow } from "./workflow-detail-rows";
import { formatListTime } from "./workflow-rows";

/** One day, from its first instant up to the next day's. */
export interface TimelineDay {
  readonly start: Date;
  readonly end: Date;
}

/** One hour line, at the start of a local hour. */
export interface TimelineHour {
  /** The line's place across the day. */
  readonly at: number;
  /** The hour, "06:00", or `undefined` when the now line's time covers it. */
  readonly label: string | undefined;
  /** Whether the hour is a multiple of three, which a narrow page labels alone. */
  readonly isMajor: boolean;
}

/** One run's bar. */
export interface TimelineBar {
  /** The run, as its row in the Runs tab's list shows it. */
  readonly run: RunRow;
  /** Where the bar starts: when the run started, or 0 when it started on a day before. */
  readonly from: number;
  /** Where the bar ends: when the run ended, now while it runs, or 1 when it went on past the day. */
  readonly to: number;
  /** The track the bar is drawn on, 0 for the top one. */
  readonly track: number;
  /** Whether the run started on a day before, so its bar is cut at the day's start. */
  readonly startsBefore: boolean;
  /** Whether the run went on past the day, so its bar is cut at the day's end. */
  readonly endsAfter: boolean;
}

/** A start trigger's next fire, within what is left of today. */
export interface TimelineFire {
  readonly triggerId: string;
  readonly at: number;
  /** When it fires, "14:00". */
  readonly text: string;
}

/** The timeline's axis for one day: the hours across it, and where now is. */
export interface TimelineAxis {
  /** The day, as the stepper above the timeline names it: "Today", "Yesterday", "27 Sep". */
  readonly dayText: string;
  readonly hours: ReadonlyArray<TimelineHour>;
  /** Where now is, with its time, "09:41", or `undefined` for a day before today. */
  readonly now: { readonly at: number; readonly text: string } | undefined;
}

/** The runs the timeline draws for one day, and the fires still to come. */
export interface TimelineBars {
  /** The bars, from the earliest start to the latest. */
  readonly bars: ReadonlyArray<TimelineBar>;
  /** How many tracks the bars take: 0 for a day with no runs. */
  readonly trackCount: number;
  readonly fires: ReadonlyArray<TimelineFire>;
}

/** The records a day of the timeline is built from. */
export interface TimelineRecords {
  /** The workflow's runs that may have run on the day. A run may be in it twice. */
  readonly runs: ReadonlyArray<RunSummary>;
  readonly definition: WorkflowDefinition;
  /** Whether the workflow is enabled. A disabled workflow's triggers do not fire. */
  readonly enabled: boolean;
  /** The sessions of the runs that wait on the user, which draw a live run as waiting. */
  readonly waitingSessions: ReadonlyArray<Session>;
  /** The workflow's own triggers. */
  readonly triggers: ReadonlyArray<Trigger>;
}

const HOUR = 3_600_000;

/**
 * The shortest time a bar holds its track for. A run of a few seconds is
 * drawn as a short bar with its mark at the end, and the next run on its
 * track must start clear of that mark, however wide the page is.
 */
const SHORTEST_TRACK_HOLD = 45 * 60_000;

/** The time on either side of now whose hour label the now line's time covers. */
const NOW_LABEL_REACH = 45 * 60_000;

/**
 * Returns the first instant of the day `instant` falls on in `timezone`,
 * which must be a supported zone. Fails for any other zone.
 */
const findDayStart = (instant: Date, timezone: string): Date => {
  const start = computeDayStart(instant, timezone);
  if (start === undefined) throw new Error(`The timezone "${timezone}" is not supported.`);
  return start;
};

/**
 * Computes the day `daysBack` days before the day `now` falls on in
 * `timezone`: 0 is today and 1 is yesterday. `timezone` must be a supported
 * zone.
 */
export const computeTimelineDay = (now: Date, daysBack: number, timezone: string): TimelineDay => {
  let start = findDayStart(now, timezone);
  for (let step = 0; step < daysBack; step++) {
    start = findDayStart(new Date(start.getTime() - 1), timezone);
  }
  // A day is 23 to 25 hours long, so 26 hours on is always within the next.
  return { start, end: findDayStart(new Date(start.getTime() + 26 * HOUR), timezone) };
};

/**
 * Computes the range of creation times to read the runs of `day` from: from
 * the start of the day before up to the day's end. A run that started before
 * midnight and ended after it was created the day before, so reading from
 * then draws it. A run created earlier still that ended in `day` is missed,
 * because `run.query` filters on when a run was created, not when it ended.
 */
export const computeTimelineReadRange = (
  day: TimelineDay,
  timezone: string,
): { readonly since: string; readonly until: string } => ({
  since: findDayStart(new Date(day.start.getTime() - 1), timezone).toISOString(),
  until: day.end.toISOString(),
});

/** Returns where `instant` falls across `day`, from 0 at its start to 1 at its end. */
const placeAcrossDay = (instant: number, day: TimelineDay): number =>
  (instant - day.start.getTime()) / (day.end.getTime() - day.start.getTime());

/** Returns `now` when it falls within `day`, or `undefined`. */
const findNowWithin = (day: TimelineDay, now: Date): number | undefined =>
  now >= day.start && now < day.end ? now.getTime() : undefined;

/**
 * Builds the timeline's axis for `day`: a line at the start of each local
 * hour after the first, and the now line when `day` is today. Times are read
 * in `timezone`, which must be a supported zone.
 */
export const buildTimelineAxis = (day: TimelineDay, timezone: string, now: Date): TimelineAxis => {
  const nowAt = findNowWithin(day, now);
  // The first line would be the day's start, which the timeline's edge already draws.
  const hours: TimelineHour[] = [];
  for (let instant = day.start.getTime() + HOUR; instant < day.end.getTime(); instant += HOUR) {
    const minutes = computeMinutesOfDay(new Date(instant), timezone);
    if (minutes === undefined) continue;
    const hour = Math.floor(minutes / 60);
    const clock = `${String(hour).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    const isUnderNow = nowAt !== undefined && Math.abs(instant - nowAt) < NOW_LABEL_REACH;
    hours.push({
      at: placeAcrossDay(instant, day),
      label: isUnderNow ? undefined : clock,
      isMajor: hour % 3 === 0,
    });
  }
  return {
    dayText: formatDayStamp(day.start, timezone, now) ?? "",
    hours,
    now:
      nowAt === undefined
        ? undefined
        : { at: placeAcrossDay(nowAt, day), text: formatListTime(now, timezone, now, "past") },
  };
};

/**
 * Builds the bars of the runs in `records` that ran on `day`, and the fires
 * still to come when `day` is today. Times are read in `timezone`, which
 * must be a supported zone, relative to `now`.
 *
 * A run that has not started is not drawn. A run is placed on the first
 * track that is free when it starts, so the runs that overlap stack and the
 * others share the top track.
 */
export const buildTimelineBars = (
  records: TimelineRecords,
  day: TimelineDay,
  timezone: string,
  now: Date,
): TimelineBars => {
  const start = day.start.getTime();
  const end = day.end.getTime();
  const nowAt = findNowWithin(day, now);

  const seen = new Set<string>();
  const spans = records.runs.flatMap((run) => {
    if (seen.has(run.id)) return [];
    seen.add(run.id);
    const { startedAt, finishedAt } = readTimestamps(run);
    if (startedAt === undefined) return [];
    const ranFrom = Date.parse(startedAt);
    const ranTo = finishedAt === undefined ? now.getTime() : Date.parse(finishedAt);
    if (ranFrom >= end || ranTo < start) return [];
    return [{ run, ranFrom, ranTo }];
  });

  // Each track's entry is when the track is free again.
  const freeFrom: number[] = [];
  const bars = spans
    .toSorted((a, b) => a.ranFrom - b.ranFrom)
    .map(({ run, ranFrom, ranTo }): TimelineBar => {
      const free = freeFrom.findIndex((instant) => instant <= ranFrom);
      const track = free === -1 ? freeFrom.length : free;
      freeFrom[track] = Math.max(ranTo, ranFrom + SHORTEST_TRACK_HOLD);
      return {
        run: buildRunRow(run, records.definition, records.waitingSessions, timezone, now),
        from: placeAcrossDay(Math.max(ranFrom, start), day),
        to: placeAcrossDay(Math.min(ranTo, end), day),
        track,
        startsBefore: ranFrom < start,
        endsAfter: ranTo > end,
      };
    });

  const fires =
    records.enabled && nowAt !== undefined
      ? records.triggers.flatMap((trigger): TimelineFire[] => {
          if (trigger.kind !== "start" || trigger.status === "paused") return [];
          if (trigger.nextFireAt === undefined) return [];
          const fireAt = Date.parse(trigger.nextFireAt);
          if (fireAt < nowAt || fireAt >= end) return [];
          return [
            {
              triggerId: trigger.triggerId,
              at: placeAcrossDay(fireAt, day),
              text: formatListTime(new Date(fireAt), timezone, now, "future"),
            },
          ];
        })
      : [];

  return { bars, trackCount: freeFrom.length, fires };
};
