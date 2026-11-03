/**
 * The forecast of when a machine's free disk space reaches its disk limit,
 * drawn on the machine's Disk graph and worded on the Fleet page (spec 17
 * §Graphs and the forecast).
 */
import type { Runner, RunnerMetricsPoint } from "@hercule/contract";
import { FORECAST_HISTORY_MS } from "./metrics-history";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The history the forecast needs, from its oldest point to its newest. */
const MIN_HISTORY_MS = 2 * DAY_MS;

/** A rise in free space of more than this share of the disk, between two points, is a cleanup. */
const JUMP_SHARE_OF_DISK = 0.1;

/** A forecast that reaches the limit further away than this many days is not shown. */
const MAX_FORECAST_DAYS = 60;

/** When a machine's free disk space is forecast to reach its disk limit. See `forecastDiskLimit`. */
export interface DiskForecast {
  /** Whole days from now until the line reaches the limit: rounded to the nearest day, at least 1. */
  readonly days: number;
  /** The fitted line at the newest point counted, where a graph's dashed line starts: Unix ms and free bytes. */
  readonly from: { readonly at: number; readonly freeBytes: number };
  /** When the fitted line reaches the limit, in Unix ms. */
  readonly reachesAt: number;
}

/** The free space of a machine at the start of one hour point. */
interface FreeSpaceSample {
  /** Unix ms. */
  readonly at: number;
  readonly freeBytes: number;
}

/**
 * Returns the samples after the last jump in free space, or all of them when
 * there is no jump. A jump is free space growing by more than 10% of
 * `diskTotalBytes` between two consecutive samples, even across a gap in the
 * history: a cleanup, after which the old fill rate says nothing.
 */
const dropSamplesBeforeLastJump = (
  samples: readonly FreeSpaceSample[],
  diskTotalBytes: number,
): readonly FreeSpaceSample[] => {
  let start = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const growth = samples[index]!.freeBytes - samples[index - 1]!.freeBytes;
    if (growth > JUMP_SHARE_OF_DISK * diskTotalBytes) start = index;
  }
  return samples.slice(start);
};

/**
 * Forecasts when the free disk space of `runner` reaches its disk limit
 * (`diskWatermarkBytes`), by a least-squares straight line through the free
 * space of its hour points. Returns `null` when there is no forecast to show.
 *
 * `points` are the hour points of `runner` alone, oldest first. The function
 * does not check whose they are, so a caller with several runners' points
 * passes each runner its own. `now` is a Unix time in ms, passed in so the
 * function reads no clock.
 *
 * - Only points that start within the 7 days before `now` are used.
 * - The line starts again after a jump: free space growing by more than 10% of
 *   the disk's total size (`runner.facts.diskTotalBytes`) between two
 *   consecutive samples, even across a gap. Only the points after the last jump
 *   are used. A runner that does not report its disk's total size gets no
 *   forecast, because the jump rule needs it.
 * - It needs 2 days: the newest point used starts at least 48 hours after the
 *   oldest. Two lone points 48 hours apart are enough.
 * - The line must fall. A slope of zero or more (free space not falling) gives
 *   no forecast.
 * - There is no forecast when the newest point's free space is already below
 *   the limit, because the machine then needs the user for that reason.
 * - There is no forecast when the fitted line is already at or below the limit
 *   at the newest point, even though that point is above it. Noisy data does
 *   this: the dashed line would run backwards or have no length.
 * - `days` is the time from `now` until the line reaches the limit, rounded to
 *   the nearest whole day and at least 1 (a line that has already crossed the
 *   limit between two reads still says 1). A forecast of more than 60 days
 *   gives no forecast.
 */
export const forecastDiskLimit = (
  points: readonly RunnerMetricsPoint[],
  runner: Runner,
  now: number,
): DiskForecast | null => {
  const diskTotalBytes = runner.facts?.diskTotalBytes;
  if (diskTotalBytes === undefined || diskTotalBytes <= 0) return null;

  const oldestAllowed = now - FORECAST_HISTORY_MS;
  const samples = points
    .map((point): FreeSpaceSample => ({ at: Date.parse(point.at), freeBytes: point.diskFreeBytes }))
    .filter(({ at }) => at >= oldestAllowed && at <= now);
  const counted = dropSamplesBeforeLastJump(samples, diskTotalBytes);
  const oldest = counted[0];
  const newest = counted.at(-1);
  if (oldest === undefined || newest === undefined) return null;
  if (newest.at - oldest.at < MIN_HISTORY_MS) return null;
  if (newest.freeBytes < runner.diskWatermarkBytes) return null;

  // Times are measured from the oldest sample so the sums stay small and exact enough.
  const count = counted.length;
  const meanTime = counted.reduce((sum, { at }) => sum + (at - oldest.at), 0) / count;
  const meanFree = counted.reduce((sum, { freeBytes }) => sum + freeBytes, 0) / count;
  let covariance = 0;
  let variance = 0;
  for (const { at, freeBytes } of counted) {
    const timeOffset = at - oldest.at - meanTime;
    covariance += timeOffset * (freeBytes - meanFree);
    variance += timeOffset * timeOffset;
  }
  // The history spans 48 hours at least, so the times are not all equal and variance is above 0.
  const slopePerMs = covariance / variance;
  if (slopePerMs >= 0) return null;

  const freeAt = (at: number): number => meanFree + slopePerMs * (at - oldest.at - meanTime);
  const reachesAt = newest.at + (runner.diskWatermarkBytes - freeAt(newest.at)) / slopePerMs;
  if (reachesAt <= newest.at) return null;
  const days = Math.max(1, Math.round((reachesAt - now) / DAY_MS));
  if (days > MAX_FORECAST_DAYS) return null;
  return { days, from: { at: newest.at, freeBytes: freeAt(newest.at) }, reachesAt };
};
