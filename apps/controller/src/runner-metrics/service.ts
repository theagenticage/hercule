/**
 * The runner metrics service: the history of each runner's Runner Metrics,
 * kept one row per runner per minute (spec 03 section 4.3).
 *
 * `record` and `prune` are for the controller itself, so they check no grant.
 * `query` is the public read.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createValidationError,
  RUNNER_METRICS_POINT_MS,
  DEFAULT_PAGE_LIMIT,
  type Forbidden,
  type RunnerMetrics,
  type RunnerMetricsQuery,
  type RunnerMetricsPoint,
  type Validation,
} from "@hercule/contract";
import { requireGrant } from "../actor";
import { announce, nowIso, refuseCursor, withTransaction } from "../db";
import { Settings } from "../settings";
import { runnerMetricsRepository } from "./repository";

/** How many days of history are kept when `retention.runnerMetrics` is not set. */
const DEFAULT_RETENTION_DAYS = 14;

/**
 * The days of history a machine's page always draws, as hour points. A query
 * for hour points may cover this many days even when the retention is shorter:
 * the days beyond the retention hold no rows, so refusing them would protect
 * nothing and only make the page fail.
 */
const MACHINE_PAGE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The longest span of five-minute points one query reads. */
const MAX_FIVE_MINUTE_SPAN_MS = DAY_MS;

/** One page of points. `nextCursor` is absent on the last page. */
interface RunnerMetricsPage {
  readonly items: ReadonlyArray<RunnerMetricsPoint>;
  readonly nextCursor?: string;
}

/** Builds the refusal of a span, which names `since` because the span is what is wrong. */
const refuseSpan = (message: string): Validation =>
  createValidationError([{ path: ["since"], message }]);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* runnerMetricsRepository;
  const settings = yield* Settings;

  /**
   * Reads how many days of history are kept. A value that is not set, or that
   * this build cannot read, reads as unset, and the default applies.
   */
  const readRetentionDays: Effect.Effect<number, SqlError> = Effect.map(
    settings.all(),
    (all) => all["retention.runnerMetrics"] ?? DEFAULT_RETENTION_DAYS,
  );

  return {
    /**
     * Records the Runner Metrics a runner reported at `at`, as the row of the
     * minute `at` falls in, together with the runner's session counts at this
     * moment. A second report in the same minute replaces the first. Must run
     * inside the transaction of the caller that handles the report. Announces
     * the runner on the `runnerMetrics` live topic once that transaction
     * commits.
     */
    record: (runnerId: string, metrics: RunnerMetrics, at: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* rows.record(runnerId, metrics, Date.parse(at));
        yield* announce({ _tag: "record", topic: "runnerMetrics", id: runnerId, kind: "updated" });
      }),

    /**
     * Returns one page of the history as points of five minutes or one hour,
     * ordered by runner and then oldest first. `since` moves back to the start
     * of its point, so every point is whole, and `until` is not included and
     * defaults to now.
     *
     * Fails with `Validation` when the span is empty, or is longer than a
     * query may read (24 hours of five-minute points, or the longer of the
     * retention period and 14 days of hour points), or when the cursor was issued for another
     * runner or resolution.
     */
    query: (
      input: RunnerMetricsQuery,
    ): Effect.Effect<RunnerMetricsPage, Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("runnerMetrics.query");
        const sinceMs = Date.parse(input.since);
        const untilMs = Date.parse(input.until ?? (yield* nowIso));
        if (sinceMs >= untilMs) {
          return yield* Effect.fail(
            refuseSpan(
              "since must be before until, which is now when left out; ask for a span that starts before it ends.",
            ),
          );
        }
        const spanMs = untilMs - sinceMs;
        if (input.resolution === "fiveMinutes" && spanMs > MAX_FIVE_MINUTE_SPAN_MS) {
          return yield* Effect.fail(
            refuseSpan(
              "five-minute points cover at most 24 hours; ask for a shorter span, or use resolution hour for a longer one.",
            ),
          );
        }
        if (input.resolution === "hour") {
          const days = Math.max(yield* readRetentionDays, MACHINE_PAGE_DAYS);
          if (spanMs > days * DAY_MS) {
            return yield* Effect.fail(
              refuseSpan(
                `hour points cover at most ${String(days)} days, the longer of the history kept and the ${String(MACHINE_PAGE_DAYS)} days a machine's page draws; ask for a shorter span.`,
              ),
            );
          }
        }
        const pointMs = RUNNER_METRICS_POINT_MS[input.resolution];
        const page = yield* refuseCursor(
          rows.readPoints({
            runnerId: input.runnerId,
            resolution: input.resolution,
            since: input.since,
            until: input.until,
            startMs: Math.floor(sinceMs / pointMs) * pointMs,
            endMs: untilMs,
            limit: input.limit ?? DEFAULT_PAGE_LIMIT,
            cursor: input.cursor,
          }),
        );
        return {
          items: page.items,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        };
      }),

    /**
     * Deletes the rows older than `retention.runnerMetrics` days before `at`
     * (14 days when the setting is not set). Opens a transaction of its own,
     * or joins the caller's.
     */
    prune: (at: string): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const days = yield* readRetentionDays;
          yield* rows.deleteBefore(Date.parse(at) - days * DAY_MS);
        }),
      ),
  };
});

export class RunnerMetricsService extends Context.Service<
  RunnerMetricsService,
  Effect.Success<typeof make>
>()("hercule/controller/runner-metrics/RunnerMetricsService") {}

export const RunnerMetricsServiceLayer: Layer.Layer<
  RunnerMetricsService,
  never,
  SqlClient.SqlClient | Settings
> = Layer.effect(RunnerMetricsService)(make);
