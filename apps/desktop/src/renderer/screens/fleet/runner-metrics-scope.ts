/**
 * Which history of Runner Metrics a Fleet page reads, and the cache key it is
 * held under. The reads themselves are in the Fleet routes
 * (`routes/_connected/_shell/fleet/-runner-metrics.ts`); the scopes are here
 * so the specimens can seed the same keys the pages read.
 */
import { queryKeys } from "@hercule/client-core";
import {
  FIVE_MINUTE_HISTORY_MS,
  FORECAST_HISTORY_MS,
  HOUR_HISTORY_MS,
} from "@hercule/client-core/metrics-history";
import type { RunnerMetricsResolution } from "@hercule/contract";

/**
 * One history of Runner Metrics: the points of one `resolution` over the last
 * `rangeMs`, for the runner `runnerId` or, with `null`, for every runner.
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

/** The five-minute points of the last 24 hours of the runner `runnerId`: a machine's Sessions, CPU and Memory graphs. */
export const buildMachineFiveMinuteScope = (runnerId: string): RunnerMetricsScope => ({
  resolution: "fiveMinutes",
  runnerId,
  rangeMs: FIVE_MINUTE_HISTORY_MS,
});

/** The hour points of the last 14 days of the runner `runnerId`: a machine's Disk graph and forecast. */
export const buildMachineHourScope = (runnerId: string): RunnerMetricsScope => ({
  resolution: "hour",
  runnerId,
  rangeMs: HOUR_HISTORY_MS,
});

/** Returns the cache key the history of `scope` is held under. */
export const buildRunnerMetricsKey = ({ resolution, runnerId, rangeMs }: RunnerMetricsScope) =>
  queryKeys.runnerMetrics(resolution, runnerId, rangeMs);
