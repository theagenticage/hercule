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
 * `[startMs, endMs)`, for one runner or for every runner.
 */
export interface PointsRequest {
  readonly runnerId: string | undefined;
  readonly resolution: RunnerMetricsResolution;
  /**
   * The span as the caller wrote it, `until` absent when it was left out. A
   * cursor is tied to it, because `startMs` and `endMs` are worked out from
   * it, and `endMs` from the clock when `until` is absent.
   */
  readonly since: string;
  readonly until: string | undefined;
  /** The start of the first point. A multiple of the resolution's length. */
  readonly startMs: number;
  /** The end of the span; rows at this minute or later are not read. */
  readonly endMs: number;
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
 * Builds the cursor scope of a points query: the runner, the resolution and
 * the span as the caller wrote it. Each of them decides which points the pages
 * hold, so a cursor from one query is refused by any query that differs in one
 * of them (see `CursorScope`).
 */
const buildCursorScope = (request: PointsRequest): CursorScope => ({
  op: "runnerMetrics.query",
  sort: [
    {
      field:
        `runner ${request.runnerId ?? "all"}, ${request.resolution} points, ` +
        `since ${request.since}, until ${request.until ?? "now"}`,
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

/** Where a page starts: the runner of the previous page's last point, and the first minute of that runner not yet read. */
export interface Resume {
  readonly runnerId: string;
  readonly minuteMs: number;
}

/**
 * One range of the primary key that a page reads. `after` reads the runners
 * that sort after `runnerId`.
 */
export interface ReadArm {
  readonly runners:
    | { readonly kind: "all" }
    | { readonly kind: "one" | "after"; readonly runnerId: string };
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * Plans the ranges one page reads, so a page after the first starts where the
 * previous one stopped instead of reading the rows it skips:
 *
 * - For one runner, a page reads from the first minute not yet read, and no
 *   further than the minutes `limit + 1` points would hold. That is the most
 *   a page can use. A stretch with gaps may hold fewer points than that, and
 *   `readPoints` then continues from the end of the range.
 * - For every runner, the first page reads each runner's range. A later page
 *   reads the rest of the cursor's runner, then the runners after it.
 */
export const planReads = (
  request: PointsRequest,
  resume: Resume | undefined,
): ReadonlyArray<ReadArm> => {
  const fromMs = Math.max(request.startMs, resume?.minuteMs ?? request.startMs);
  if (request.runnerId !== undefined) {
    const pageMs = (request.limit + 1) * RUNNER_METRICS_POINT_MS[request.resolution];
    return [
      {
        runners: { kind: "one", runnerId: request.runnerId },
        fromMs,
        toMs: Math.min(request.endMs, fromMs + pageMs),
      },
    ];
  }
  if (resume === undefined) {
    return [{ runners: { kind: "all" }, fromMs, toMs: request.endMs }];
  }
  return [
    { runners: { kind: "one", runnerId: resume.runnerId }, fromMs, toMs: request.endMs },
    {
      runners: { kind: "after", runnerId: resume.runnerId },
      fromMs: request.startMs,
      toMs: request.endMs,
    },
  ];
};

const buildArmStatement = (sql: SqlClient.SqlClient, arm: ReadArm) => {
  const runners =
    arm.runners.kind === "all"
      ? sql`runner_id IN (SELECT id FROM runners)`
      : arm.runners.kind === "one"
        ? sql`runner_id = ${uuidFromString(arm.runners.runnerId)}`
        : sql`runner_id IN (SELECT id FROM runners WHERE id > ${uuidFromString(arm.runners.runnerId)})`;
  return sql`
    SELECT runner_id, minute, disk_free_bytes, available_memory_bytes, cpu_average_percent,
           cpu_peak_percent, sessions_running, sessions_queued
    FROM runner_metrics
    WHERE ${runners} AND minute >= ${arm.fromMs} AND minute < ${arm.toMs}
  `;
};

/**
 * Builds the statement that reads one page of points, plus one point more than
 * the page holds. It is one statement:
 *
 * - Each arm of `planReads` is a range on the raw `minute` column under a
 *   runner, so the primary key serves it. Without a runner,
 *   `runner_id IN (SELECT id FROM runners)` makes SQLite seek each runner's
 *   range, rather than read every row of the table.
 * - A point is a group of rows. Its start is `minute` less its remainder in the
 *   point's length, so points fall on fixed UTC boundaries.
 * - The page boundary is on the raw rows, before they are grouped: the arms
 *   start at the first minute after the cursor's point. A point is therefore
 *   never split between two pages.
 *
 * `GROUP BY` sorts the rows of the arms in a temporary b-tree before `LIMIT`
 * applies, because a point's start is an expression and no index is ordered
 * by it. So a page costs the rows of its ranges, which `planReads` keeps near
 * the size of a page for one runner, and shrinks as a read for every runner
 * goes on.
 */
export const buildPointsStatement = (
  sql: SqlClient.SqlClient,
  request: PointsRequest,
  arms: ReadonlyArray<ReadArm>,
): Statement<PointRow> => {
  const pointMs = RUNNER_METRICS_POINT_MS[request.resolution];
  const reads = sql.join(" UNION ALL ", false)(arms.map((arm) => buildArmStatement(sql, arm)));
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
    FROM (${reads})
    GROUP BY runner_id, bucket
    ORDER BY runner_id, bucket
    LIMIT ${request.limit + 1}
  `;
};

/**
 * Builds the statement that finds the first minute a runner has a row in
 * `[fromMs, toMs)`. It reads one entry of the primary key.
 */
export const buildNextMinuteStatement = (
  sql: SqlClient.SqlClient,
  runnerId: string,
  fromMs: number,
  toMs: number,
): Statement<{ readonly minute: number }> => sql<{ readonly minute: number }>`
  SELECT minute FROM runner_metrics
  WHERE runner_id = ${uuidFromString(runnerId)} AND minute >= ${fromMs} AND minute < ${toMs}
  ORDER BY minute LIMIT 1
`;

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
     * Fails with `CursorError` when the cursor was not issued for this runner,
     * resolution and span.
     *
     * A read for one runner covers a bounded range (see `planReads`). When
     * that range ends before the span does and holds no more than a page of
     * points, the page still has a `nextCursor` when the runner has rows
     * further on, which resumes at the next point that has any. Without it, a
     * gap in the history would end the read early.
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
        const arms = planReads(
          request,
          cursor === undefined
            ? undefined
            : { runnerId: cursor.id, minuteMs: Number(cursor.values[0]) + pointMs },
        );
        const rows = yield* buildPointsStatement(sql, request, arms);
        const page = yield* buildPage(
          rows,
          request.limit,
          (pageRows) => Effect.succeed(pageRows.map(toPoint)),
          (last) => encodeCursor(scope, [Date.parse(last.at)], last.runnerId),
        );
        const rangeEndMs = arms[0]!.toMs;
        if (
          page.nextCursor !== undefined ||
          request.runnerId === undefined ||
          rangeEndMs >= request.endMs
        ) {
          return page;
        }
        // The range ended before the span did and held no more than a page of
        // points. If the runner has rows further on, the cursor resumes at the
        // point of the first of them, so a gap costs no empty page.
        const [next] = yield* buildNextMinuteStatement(
          sql,
          request.runnerId,
          rangeEndMs,
          request.endMs,
        );
        if (next === undefined) return page;
        const nextPointMs = next.minute - (next.minute % pointMs);
        return {
          items: page.items,
          nextCursor: encodeCursor(scope, [nextPointMs - pointMs], request.runnerId),
        };
      }),

    /** Deletes the rows of every minute before `cutoffMs`. Must run inside a transaction. */
    deleteBefore: (cutoffMs: number): Effect.Effect<void, SqlError> =>
      Effect.asVoid(buildPruneStatement(sql, cutoffMs)),
  };
});

export const runnerMetricsRepository = make;
