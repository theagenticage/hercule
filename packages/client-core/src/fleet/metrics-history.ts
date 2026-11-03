/**
 * The Runner Metrics a Fleet screen holds, and how a re-read joins them
 * (spec 03 §4.3, spec 17 §Graphs and the forecast).
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
export const findMetricsReadStart = (
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
 * - `since` is the value `findMetricsReadStart` gave. The held points that
 *   start at or after it were still filling, so the read replaces them.
 * - Points older than `readAt - rangeMs` are dropped, so the history never
 *   grows past the range its graph draws.
 *
 * The result keeps the sort in one pass over both lists. When the read is empty
 * and nothing is dropped, it returns `held` itself, so a caller comparing by
 * identity (React, TanStack Query) redraws nothing.
 */
export const mergeRunnerMetricsHistory = (
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
