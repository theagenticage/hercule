/**
 * Runner Metrics history: how a machine was used over the last days.
 *
 * The controller keeps one row of Runner Metrics per runner per minute. This
 * group reads them as points, each computed from the rows inside a span of
 * five minutes or one hour, never as single minutes. See spec 03 section 4.3.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { Forbidden, Internal, Unauthenticated, Validation } from "../errors";
import { Id, Timestamp, TimestampWithOffset } from "../ids";
import { cursorParams, page } from "../pagination";
import { Authenticated } from "../security";

/**
 * How long a point is: `fiveMinutes` points start on UTC multiples of five
 * minutes, and `hour` points are whole UTC hours.
 */
const RUNNER_METRICS_RESOLUTIONS = ["fiveMinutes", "hour"] as const;

export const RunnerMetricsResolution = Schema.Literals(RUNNER_METRICS_RESOLUTIONS);

export type RunnerMetricsResolution = Schema.Schema.Type<typeof RunnerMetricsResolution>;

/** How long a point of each resolution is, in milliseconds: the one spelling every package uses. */
export const RUNNER_METRICS_POINT_MS: Readonly<Record<RunnerMetricsResolution, number>> = {
  fiveMinutes: 5 * 60_000,
  hour: 60 * 60_000,
};

const Bytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Percent = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }));

const SessionCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * One runner's Runner Metrics over one span of time, computed from the minutes
 * inside it. A CPU value is null when no minute in the span had one.
 */
export const RunnerMetricsPoint = Schema.Struct({
  runnerId: Id,
  /** When the point starts. */
  at: Timestamp,
  /** How many minutes of the span have a row, so a client can tell a gap from a quiet machine. */
  minutes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** The mean of the free disk of the minutes, rounded to a whole byte. */
  diskFreeBytes: Bytes,
  /** The mean of the available memory of the minutes, rounded to a whole byte. */
  availableMemoryBytes: Bytes,
  /** The lowest available memory of any minute. */
  availableMemoryLowestBytes: Bytes,
  /** The mean of the minutes' CPU averages. */
  cpuAveragePercent: Schema.NullOr(Percent),
  /** The highest CPU read of any minute. */
  cpuPeakPercent: Schema.NullOr(Percent),
  /** The most sessions that held a slot in any minute. */
  sessionsRunning: SessionCount,
  /** The most sessions that were queued for the runner in any minute. */
  sessionsQueued: SessionCount,
});

export type RunnerMetricsPoint = Schema.Schema.Type<typeof RunnerMetricsPoint>;

/**
 * The input of `runnerMetrics.query`. `since` is moved back to the start of
 * its point, so every point returned is whole. `until` is exclusive and
 * defaults to now. Without `runnerId`, the points of every runner. A time may
 * be written with any offset, and is read as the UTC time it names.
 */
export const RunnerMetricsQuery = Schema.Struct({
  runnerId: Schema.optionalKey(Id),
  since: TimestampWithOffset,
  until: Schema.optionalKey(TimestampWithOffset),
  resolution: RunnerMetricsResolution,
  ...cursorParams.fields,
});

export type RunnerMetricsQuery = Schema.Schema.Type<typeof RunnerMetricsQuery>;

export const runnerMetrics = HttpApiGroup.make("runnerMetrics")
  .add(
    HttpApiEndpoint.get("query", "/runner-metrics", {
      query: RunnerMetricsQuery,
      success: page(RunnerMetricsPoint),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
  )
  .middleware(Authenticated);
