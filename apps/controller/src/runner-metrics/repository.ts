/**
 * The repository for the `runner_metrics` table: one row per runner per
 * minute. Nothing here decides policy. Every statement reaches the rows through
 * the table's primary key, `(runner_id, minute)`, which is the only index.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { Statement } from "effect/sql/Statement";
import {
  RUNNER_METRICS_POINT_MS,
  type RunnerMetrics,
  type RunnerMetricsPoint,
  type RunnerMetricsResolution,
} from "@hercule/contract";
import {
  buildPage,
  decodeCursor,
  encodeCursor,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
} from "../db";

const MINUTE_MS = 60_000;

/** Returns the start of the minute that `instantMs` falls in, in Unix milliseconds. */
export const floorToMinute = (instantMs: number): number => instantMs - (instantMs % MINUTE_MS);

/**
 * What `readPoints` reads: the points of one resolution whose rows lie in
 * `[sinceMs, untilMs)`, for one runner or for every runner.
 */
export interface PointsRequest {
  readonly runnerId: string | undefined;
  readonly resolution: RunnerMetricsResolution;
  /** The start of the first point. A multiple of the resolution's length. */
  readonly sinceMs: number;
  /** The end of the span; rows at this minute or later are not read. */
  readonly untilMs: number;
  readonly limit: number;
  readonly cursor: string | undefined;
}

interface PointRow {
  readonly runner_id: Uint8Array;
  readonly bucket: number;
  readonly minutes: number;
  readonly disk_free_bytes: number;
  readonly available_memory_bytes: number;
  readonly available_memory_lowest_bytes: number;
  readonly cpu_average_percent: number | null;
  readonly cpu_peak_percent: number | null;
  readonly sessions_running: number;
  readonly sessions_queued: number;
}

/**
 * Builds the cursor scope of a points query. The filters that change which
 * points exist, the runner and the resolution, are part of the scope, so a
 * cursor from one query is refused by another (see `CursorScope`).
 */
const buildCursorScope = (request: PointsRequest): CursorScope => ({
  op: "runnerMetrics.query",
  sort: [
    {
      field: `runner ${request.runnerId ?? "all"}, ${request.resolution} points`,
      direction: "asc",
    },
  ],
});

/** Rounds a CPU mean to one decimal place, which is finer than any screen shows. */
const roundPercent = (percent: number): number => Math.round(percent * 10) / 10;

const toPoint = (row: PointRow): RunnerMetricsPoint => ({
  runnerId: uuidToString(row.runner_id),
  at: new Date(row.bucket).toISOString(),
  minutes: row.minutes,
  diskFreeBytes: Math.round(row.disk_free_bytes),
  availableMemoryBytes: Math.round(row.available_memory_bytes),
  availableMemoryLowestBytes: row.available_memory_lowest_bytes,
  cpuAveragePercent:
    row.cpu_average_percent === null ? null : roundPercent(row.cpu_average_percent),
  cpuPeakPercent: row.cpu_peak_percent,
  sessionsRunning: row.sessions_running,
  sessionsQueued: row.sessions_queued,
});

/**
 * Builds the statement that writes the row of a runner's minute: the report's
 * values and the runner's session counts, read by the same statement. A row
 * already there for the minute is replaced in every column.
 *
 * The counts read `sessions_live_by_runner`, the index over the runner's
 * sessions that have not exited, so they never read its finished sessions.
 * The aggregate always returns one row, so a runner with no sessions gets
 * zeros. SQLite needs the `WHERE` in an `INSERT ... SELECT` followed by
 * `ON CONFLICT`.
 */
export const buildRecordStatement = (
  sql: SqlClient.SqlClient,
  runnerId: string,
  minuteMs: number,
  metrics: RunnerMetrics,
): Statement<object> => {
  const runner = uuidFromString(runnerId);
  return sql`
    INSERT INTO runner_metrics
      (runner_id, minute, disk_free_bytes, available_memory_bytes, cpu_average_percent,
       cpu_peak_percent, sessions_running, sessions_queued)
    SELECT ${runner}, ${minuteMs}, ${metrics.diskFreeBytes}, ${metrics.availableMemoryBytes},
           ${metrics.cpu?.averagePercent ?? null}, ${metrics.cpu?.peakPercent ?? null},
           COUNT(*) FILTER (WHERE status IN ('starting', 'idle', 'busy')),
           COUNT(*) FILTER (WHERE status = 'queued')
    FROM sessions
    WHERE runner_id = ${runner} AND status IN ('queued', 'starting', 'idle', 'busy')
    ON CONFLICT (runner_id, minute) DO UPDATE SET
      disk_free_bytes = excluded.disk_free_bytes,
      available_memory_bytes = excluded.available_memory_bytes,
      cpu_average_percent = excluded.cpu_average_percent,
      cpu_peak_percent = excluded.cpu_peak_percent,
      sessions_running = excluded.sessions_running,
      sessions_queued = excluded.sessions_queued
  `;
};

/**
 * Builds the statement that reads one page of points, plus one row more than
 * the page holds. It is one statement:
 *
 * - The range is on the raw `minute` column, so the primary key serves it.
 *   Without a runner, `runner_id IN (SELECT id FROM runners)` makes SQLite seek
 *   each runner's range, rather than read every row of the table.
 * - A point is a group of rows. Its start is `minute` less its remainder in the
 *   point's length, so points fall on fixed UTC boundaries.
 * - The page boundary is on the raw rows, before they are grouped: it starts
 *   at the first minute of the point after the cursor's. A point is therefore
 *   never split between two pages.
 */
export const buildPointsStatement = (
  sql: SqlClient.SqlClient,
  request: PointsRequest,
  after: { readonly runnerId: string; readonly minuteMs: number } | undefined,
): Statement<PointRow> => {
  const pointMs = RUNNER_METRICS_POINT_MS[request.resolution];
  const runnerClause =
    request.runnerId === undefined
      ? sql`runner_id IN (SELECT id FROM runners)`
      : sql`runner_id = ${uuidFromString(request.runnerId)}`;
  const boundary =
    after === undefined
      ? sql`1 = 1`
      : sql`(runner_id > ${uuidFromString(after.runnerId)}
             OR (runner_id = ${uuidFromString(after.runnerId)} AND minute >= ${after.minuteMs}))`;
  return sql<PointRow>`
    SELECT runner_id,
           minute - (minute % ${pointMs}) AS bucket,
           COUNT(*) AS minutes,
           AVG(disk_free_bytes) AS disk_free_bytes,
           AVG(available_memory_bytes) AS available_memory_bytes,
           MIN(available_memory_bytes) AS available_memory_lowest_bytes,
           AVG(cpu_average_percent) AS cpu_average_percent,
           MAX(cpu_peak_percent) AS cpu_peak_percent,
           MAX(sessions_running) AS sessions_running,
           MAX(sessions_queued) AS sessions_queued
    FROM runner_metrics
    WHERE ${runnerClause}
      AND minute >= ${request.sinceMs} AND minute < ${request.untilMs}
      AND ${boundary}
    GROUP BY runner_id, bucket
    ORDER BY runner_id, bucket
    LIMIT ${request.limit + 1}
  `;
};

/**
 * Builds the statement that deletes the rows before `cutoffMs`. Each runner's
 * rows are one range of the primary key, which leads with `runner_id`, so the
 * statement seeks the key once per runner. A bare `WHERE minute < ?` cannot
 * use the key and would read every row. Rows of a deleted runner are not
 * reached here: the foreign key removes them with the runner.
 */
export const buildPruneStatement = (
  sql: SqlClient.SqlClient,
  cutoffMs: number,
): Statement<object> => sql`
  DELETE FROM runner_metrics
  WHERE runner_id IN (SELECT id FROM runners) AND minute < ${cutoffMs}
`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /**
     * Writes the row for the minute `atMs` falls in, replacing the row that
     * minute already has. Must run inside a transaction.
     */
    record: (
      runnerId: string,
      metrics: RunnerMetrics,
      atMs: number,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(buildRecordStatement(sql, runnerId, floorToMinute(atMs), metrics)),

    /**
     * Returns one page of points, ordered by runner and then oldest first.
     * Fails with `CursorError` when the cursor was not issued for this runner
     * and resolution.
     */
    readPoints: (
      request: PointsRequest,
    ): Effect.Effect<Page<RunnerMetricsPoint>, SqlError | CursorError> =>
      Effect.gen(function* () {
        const scope = buildCursorScope(request);
        const pointMs = RUNNER_METRICS_POINT_MS[request.resolution];
        const cursor =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, ["number"]);
        const rows = yield* buildPointsStatement(
          sql,
          request,
          cursor === undefined
            ? undefined
            : { runnerId: cursor.id, minuteMs: Number(cursor.values[0]) + pointMs },
        );
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toPoint)),
          (last) => encodeCursor(scope, [Date.parse(last.at)], last.runnerId),
        );
      }),

    /** Deletes the rows of every minute before `cutoffMs`. Must run inside a transaction. */
    deleteBefore: (cutoffMs: number): Effect.Effect<void, SqlError> =>
      Effect.asVoid(buildPruneStatement(sql, cutoffMs)),
  };
});

export const runnerMetricsRepository = make;
