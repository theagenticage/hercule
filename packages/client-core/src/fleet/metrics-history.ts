/**
 * The Runner Metrics a Fleet screen holds, and how it reads them (spec 03
 * §4.3, spec 17 §Graphs and the forecast).
 *
 * A screen holds a few histories, each described by a `RunnerMetricsScope`.
 * `readRunnerMetricsHistory` brings one up to date: the first read covers the
 * whole range, and every later one reads only from the newest point it holds.
 *
 * The comparisons use the points' `at` strings as they are. A `Timestamp` is
 * always UTC with milliseconds (`2026-11-03T09:05:00.000Z`), so the strings
 * sort in time order and nothing needs parsing.
 */
import {
  RUNNER_METRICS_POINT_MS,
  type RunnerMetricsPoint,
  type RunnerMetricsResolution,
} from "@hercule/contract";
import type { HerculeClient } from "../client";
import { readEveryPage } from "../read-every-page";

/**
 * The points of one resolution (five minutes or one hour) that a screen holds
 * for the runners it draws, and when they were read.
 */
export interface RunnerMetricsHistory {
  /** Sorted by runner id, then oldest first. */
  readonly points: readonly RunnerMetricsPoint[];
  /** Unix ms of the read that last changed `points`: the right edge of a graph. */
  readonly readAt: number;
}

/** The history of a screen that has read nothing yet. */
export const EMPTY_RUNNER_METRICS_HISTORY: RunnerMetricsHistory = { points: [], readAt: 0 };

const DAY_MS = 24 * 60 * 60 * 1000;

/** The time the Sessions, CPU and Memory graphs of a machine's page cover: their history holds five-minute points. */
export const FIVE_MINUTE_HISTORY_MS = DAY_MS;

/** The time the Disk graph of a machine's page covers: its history holds hour points. */
export const HOUR_HISTORY_MS = 14 * DAY_MS;

/** How far back the disk forecast reads hour points: the Fleet page reads this much history. */
export const FORECAST_HISTORY_MS = 7 * DAY_MS;

/**
 * One history of Runner Metrics: the points of one `resolution` over the last
 * `rangeMs`, for the runner `runnerId` or, with `null`, for every runner. It is
 * also what a history is keyed by in the cache (`queryKeys.runnerMetrics`).
 */
export interface RunnerMetricsScope {
  readonly resolution: RunnerMetricsResolution;
  readonly runnerId: string | null;
  readonly rangeMs: number;
}

/** The hour points of every runner over the last 7 days, which the Fleet page forecasts disks from. */
export const FLEET_HOUR_METRICS_SCOPE: RunnerMetricsScope = {
  resolution: "hour",
  runnerId: null,
  rangeMs: FORECAST_HISTORY_MS,
};

/** Returns the five-minute points of the last 24 hours of the runner `runnerId`: a machine's Sessions, CPU and Memory graphs. */
export const buildMachineFiveMinuteScope = (runnerId: string): RunnerMetricsScope => ({
  resolution: "fiveMinutes",
  runnerId,
  rangeMs: FIVE_MINUTE_HISTORY_MS,
});

/** Returns the hour points of the last 14 days of the runner `runnerId`: a machine's Disk graph and forecast. */
export const buildMachineHourScope = (runnerId: string): RunnerMetricsScope => ({
  resolution: "hour",
  runnerId,
  rangeMs: HOUR_HISTORY_MS,
});

/**
 * Returns the `since` of the next read of `resolution` points over `rangeMs`,
 * at `now` (Unix ms).
 *
 * - When the history holds a point inside the range, it is the start of the
 *   newest point across all runners: the read replaces that point, which was
 *   still filling, and appends the rest. One runner's newest point can be
 *   older than another's. That is fine, because every read covers every runner
 *   up to the time of the read, so a runner with no newer point has none to
 *   read.
 * - Otherwise it is the start of the range, so the read covers all of it. This
 *   also happens after a long sleep, when the newest point is older than the
 *   range.
 *
 * The start of the range is `now - rangeMs` rounded down to a point boundary,
 * plus two points. The controller refuses a span wider than the range,
 * measuring it from the `since` the client sent to the time it answers. The
 * two extra points keep a little clock difference and the request's own time
 * from tipping a first read over that limit. The one or two far-left points it
 * skips are outside what a graph draws. Being on a boundary also means a held
 * point never overlaps a read.
 */
const findReadStart = (
  held: RunnerMetricsHistory,
  resolution: RunnerMetricsResolution,
  rangeMs: number,
  now: number,
): string => {
  const pointMs = RUNNER_METRICS_POINT_MS[resolution];
  const rangeStart = new Date(
    Math.floor((now - rangeMs) / pointMs) * pointMs + 2 * pointMs,
  ).toISOString();
  let newest = rangeStart;
  for (const { at } of held.points) {
    if (at > newest) newest = at;
  }
  return newest;
};

/**
 * Joins a re-read to the history a screen holds, and returns the new history.
 *
 * - `read` is what `runnerMetrics.query` returned for `since`, sorted by runner
 *   id, then oldest first, like the held points.
 * - `since` is the value `findReadStart` gave. The held points that
 *   start at or after it were still filling, so the read replaces them.
 * - Points older than `readAt - rangeMs` are dropped, so the history never
 *   grows past the range its graph draws.
 *
 * The result keeps the sort in one pass over both lists. When the read is empty
 * and nothing is dropped, it returns `held` itself, so a caller comparing by
 * identity (React, TanStack Query) redraws nothing.
 */
const mergeRead = (
  held: RunnerMetricsHistory,
  read: readonly RunnerMetricsPoint[],
  since: string,
  readAt: number,
  rangeMs: number,
): RunnerMetricsHistory => {
  const oldestKept = new Date(readAt - rangeMs).toISOString();
  const kept = held.points.filter((point) => point.at < since && point.at >= oldestKept);
  const nothingDropped = kept.length === held.points.length;
  if (read.length === 0 && nothingDropped) return held;

  // Every kept point starts before `since` and every read point at or after
  // it, so two points of one runner never tie.
  const points: RunnerMetricsPoint[] = [];
  let keptIndex = 0;
  let readIndex = 0;
  while (keptIndex < kept.length && readIndex < read.length) {
    const keptPoint = kept[keptIndex]!;
    const readPoint = read[readIndex]!;
    const keptFirst =
      keptPoint.runnerId === readPoint.runnerId
        ? keptPoint.at < readPoint.at
        : keptPoint.runnerId < readPoint.runnerId;
    if (keptFirst) {
      points.push(keptPoint);
      keptIndex += 1;
    } else {
      points.push(readPoint);
      readIndex += 1;
    }
  }
  while (keptIndex < kept.length) points.push(kept[keptIndex++]!);
  while (readIndex < read.length) points.push(read[readIndex++]!);
  return { points, readAt };
};

/**
 * Brings the history `held` of `scope` up to date at `now` (Unix ms), and
 * returns the new history. Fails when a request fails.
 *
 * - It reads from where `findReadStart` says, every page of it.
 * - Every page ends at the same `until`, `now`. Left to itself, each page would
 *   end at the controller's own time, and a read that crosses an hour boundary
 *   between two pages could return one runner's 10:00 hour half filled and
 *   another's 11:00 hour. The next read would start at 11:00 and the first
 *   runner's 10:00 would never be completed. It also keeps a point from
 *   starting after the history's right edge when the controller's clock is
 *   ahead of the caller's.
 * - The read joins the held points as `mergeRead` describes. The result is
 *   `held` itself when nothing changed.
 */
export const readRunnerMetricsHistory = async (
  client: HerculeClient,
  scope: RunnerMetricsScope,
  held: RunnerMetricsHistory,
  now: number,
): Promise<RunnerMetricsHistory> => {
  const { resolution, runnerId, rangeMs } = scope;
  const since = findReadStart(held, resolution, rangeMs, now);
  const until = new Date(now).toISOString();
  const read = await readEveryPage((page) =>
    client.runnerMetrics.query({
      query: { ...(runnerId === null ? {} : { runnerId }), since, until, resolution, ...page },
    }),
  );
  return mergeRead(held, read, since, now, rangeMs);
};
