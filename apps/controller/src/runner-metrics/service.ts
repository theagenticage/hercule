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
  DEFAULT_PAGE_LIMIT,
  type Forbidden,
  type RunnerMetrics,
  type RunnerMetricsPoint,
  type RunnerMetricsResolution,
  type Validation,
} from "@hercule/contract";
import { requireGrant } from "../actor";
import { announce, nowIso, refuseCursor, withTransaction } from "../db";
import { Settings } from "../settings";
import { POINT_MS, runnerMetricsRepository } from "./repository";

/** How many days of history are kept when `retention.runnerMetrics` is not set. */
const DEFAULT_RETENTION_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The longest span of five-minute points one query reads. */
const MAX_FIVE_MINUTE_SPAN_MS = DAY_MS;

/** What `runnerMetrics.query` takes, after the transport has decoded it. */
export interface QueryInput {
  readonly runnerId?: string;
  readonly since: string;
  readonly until?: string;
  readonly resolution: RunnerMetricsResolution;
  readonly limit?: number;
  readonly cursor?: string;
}

/** One page of points. `nextCursor` is absent on the last page. */
export interface RunnerMetricsPage {
  readonly items: ReadonlyArray<RunnerMetricsPoint>;
  readonly nextCursor?: string;
}

/**
 * Parses an instant a caller sent into Unix milliseconds. Fails with
 * `Validation` naming the field when the text has the right shape but is not a
 * real date, such as month 13.
 */
const parseInstant = (
  field: "since" | "until",
  text: string,
): Effect.Effect<number, Validation> => {
  const instant = Date.parse(text);
  return Number.isNaN(instant)
    ? Effect.fail(
        createValidationError([
          {
            path: [field],
            message: `${text} is not a real date and time; write it like 2026-11-02T08:00:00.000Z.`,
          },
        ]),
      )
    : Effect.succeed(instant);
};

const refuse = (field: "since" | "until", message: string): Validation =>
  createValidationError([{ path: [field], message }]);

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
     * query may read (24 hours of five-minute points, or the retention
     * period of hour points), or when the cursor was issued for another
     * runner or resolution.
     */
    query: (
      input: QueryInput,
    ): Effect.Effect<RunnerMetricsPage, Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("runnerMetrics.query");
        const sinceMs = yield* parseInstant("since", input.since);
        const untilMs =
          input.until === undefined
            ? Date.parse(yield* nowIso)
            : yield* parseInstant("until", input.until);
        if (sinceMs >= untilMs) {
          return yield* Effect.fail(
            refuse(
              "since",
              "since must be before until, which is now when left out; ask for a span that starts before it ends.",
            ),
          );
        }
        const spanMs = untilMs - sinceMs;
        if (input.resolution === "fiveMinutes" && spanMs > MAX_FIVE_MINUTE_SPAN_MS) {
          return yield* Effect.fail(
            refuse(
              "since",
              "five-minute points cover at most 24 hours; ask for a shorter span, or use resolution hour for a longer one.",
            ),
          );
        }
        if (input.resolution === "hour") {
          const days = yield* readRetentionDays;
          if (spanMs > days * DAY_MS) {
            return yield* Effect.fail(
              refuse(
                "since",
                `hour points cover at most ${String(days)} days, as long as the history is kept; ask for a shorter span.`,
              ),
            );
          }
        }
        const pointMs = POINT_MS[input.resolution];
        const page = yield* refuseCursor(
          rows.readPoints({
            runnerId: input.runnerId,
            resolution: input.resolution,
            sinceMs: Math.floor(sinceMs / pointMs) * pointMs,
            untilMs,
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
