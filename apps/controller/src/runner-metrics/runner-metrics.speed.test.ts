/**
 * Times the Runner Metrics history against a database arranged as production
 * arranges one, and prints the medians and the slowest runs. Run it with
 * `pnpm test:speed`.
 *
 * It is opt-in, and not part of `pnpm test` or CI, because time depends on the
 * machine. The database is the test database every controller test uses: a
 * file in a temporary folder, in WAL mode, with a writer and a read-only
 * reader (ADR 0004, amendment of 2026-10-18), not SQLite's in-memory mode. It
 * is seeded with a migrated schema and no statistics, as a controller starts.
 *
 * The database holds 5 runners, each with 14 days of one row a minute (100,800
 * rows in all) and one hour more that is older than the retention. Each runner
 * also has 4 live sessions and 2,000 that have exited, so the count that each
 * write makes has sessions to skip. It times the real statements, through the
 * real `RunnerMetricsService`:
 *
 * - the Fleet page's read: every runner's hour points of the last 7 days;
 * - every runner's hour points of the last 14 days, the longest read allowed;
 * - a machine page's read: one runner's five-minute points of the last 24 hours;
 * - a machine page's read after a `runnerMetrics` nudge: one runner's
 *   five-minute points from the start of the newest point;
 * - `record` of one runner's minute, in its own transaction;
 * - `prune` of the hour of 5 runners that is past the retention (300 rows).
 *
 * Each read asks for pages of `MAX_PAGE_LIMIT` points and reads every page, as
 * the desktop app does (`readRunnerMetricsHistory` in client-core). The bytes
 * are those of the pages encoded with the contract's page schema, as the
 * controller sends them.
 *
 * What it guards is an order of magnitude: each statement walks one range of
 * the table's primary key per runner, so its time follows the rows inside its
 * span, not the whole history. The read of every runner's 14 days reads every
 * row by design, so its ceiling only bounds the reads of hour points. The
 * ceilings of one runner's reads and of the two writes are far above what they
 * take and far below a walk of every row.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  MAX_PAGE_LIMIT,
  page,
  RUNNER_METRICS_POINT_MS,
  RunnerMetricsPoint,
  type RunnerMetricsQuery,
} from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { withTransaction } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { SettingsLayer } from "../settings";
import { RunnerMetricsService, RunnerMetricsServiceLayer } from "./index";

/** Set to "1" by `pnpm test:speed`. */
const SPEED_TESTS_ENABLED = process.env["RUN_SPEED_TESTS"] === "1";

/** The most time a read of every page of every runner's hour points may take, in milliseconds. */
const EVERY_RUNNER_READ_CEILING_MS = 250;

/** The most time a read of every page of one runner's five-minute points may take, in milliseconds. */
const ONE_RUNNER_READ_CEILING_MS = 10;

/** The most time one `record` or one `prune` may take, in milliseconds. */
const WRITE_CEILING_MS = 5;

/** How often each statement is timed after it has warmed up. */
const RUNS = 25;
const WARM_UP_RUNS = 5;

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const RUNNERS = 5;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The rows each runner has inside the retention: 14 days of minutes. */
const KEPT_MINUTES = (14 * DAY_MS) / MINUTE_MS;

/** The rows each runner has past the retention: one hour of minutes. */
const EXPIRED_MINUTES = 60;

/** The live sessions and the exited sessions of each runner. */
const LIVE_SESSIONS = 4;
const EXITED_SESSIONS = 2000;

/**
 * The start of the minute the test starts in. The seeded rows are the minutes
 * before it, so the newest row is one minute old, as it is between two reports.
 */
const CURRENT_MINUTE_MS = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;

/** SQL for the id of runner `r` as 32 hex digits: a version 7 UUID that holds `r`. */
const RUNNER_ID = "printf('%08x000070008000%012x', r, 0)";

/** Returns the canonical id of runner `r`, the id `RUNNER_ID` writes. */
const buildRunnerId = (r: number): string =>
  `${r.toString(16).padStart(8, "0")}-0000-7000-8000-000000000000`;

/**
 * Writes the rows of runner metrics for the minutes `k` from `firstK` to
 * `lastK` before `CURRENT_MINUTE_MS`, for every runner. Each value varies with
 * `k`, and every fifth minute has no CPU, as a runner too old to read it reports.
 */
const insertMinutes = (firstK: number, lastK: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      WITH RECURSIVE n(r) AS (SELECT 1 UNION ALL SELECT r + 1 FROM n WHERE r < ${RUNNERS}),
           m(k) AS (SELECT ${firstK} UNION ALL SELECT k + 1 FROM m WHERE k < ${lastK})
      INSERT INTO runner_metrics (runner_id, minute, disk_free_bytes, available_memory_bytes,
                                  cpu_average_percent, cpu_peak_percent, sessions_running,
                                  sessions_queued)
      SELECT ${sql.literal(`unhex(${RUNNER_ID})`)}, ${CURRENT_MINUTE_MS} - k * ${MINUTE_MS},
             200000000000 - k * 1000000, 8000000000 + (k % 97) * 10000000,
             CASE WHEN k % 5 = 0 THEN NULL ELSE (k % 83) + 0.25 END,
             CASE WHEN k % 5 = 0 THEN NULL ELSE (k % 83) + 10 END,
             k % 4, k % 3
      FROM n CROSS JOIN m`;
  });

/** Writes the runners, their sessions, and every row of runner metrics, in one transaction. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    WITH RECURSIVE n(r) AS (SELECT 1 UNION ALL SELECT r + 1 FROM n WHERE r < ${RUNNERS})
    INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels, credential_hash,
                         created_at, updated_at)
    SELECT ${sql.literal(`unhex(${RUNNER_ID})`)}, 'runner ' || r, 'online', 'active', 0, '[]',
           'hash ' || r, '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z'
    FROM n`;
  // Session j of each runner is busy for j up to 2, idle for 3, queued for 4,
  // and exited after that.
  yield* sql`
    WITH RECURSIVE n(r) AS (SELECT 1 UNION ALL SELECT r + 1 FROM n WHERE r < ${RUNNERS}),
         s(j) AS (SELECT 1 UNION ALL SELECT j + 1 FROM s
                  WHERE j < ${LIVE_SESSIONS + EXITED_SESSIONS}),
         ids(r, j, id) AS (SELECT r, j, unhex(printf('%08x000070008002%012x', r, j))
                           FROM n CROSS JOIN s)
    INSERT INTO sessions (id, permission_profile_id, provider_account_id, runner_id,
                          requested_access_mode, access_mode, spec, title, status, created_at,
                          last_activity_at, token_hash)
    SELECT id, id, id, ${sql.literal(`unhex(${RUNNER_ID})`)}, 'auto', 'auto', '{}', 'a session',
           CASE WHEN j <= 2 THEN 'busy' WHEN j = 3 THEN 'idle' WHEN j = 4 THEN 'queued'
                ELSE 'exited' END,
           '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z',
           CASE WHEN j <= 3 THEN 'hash-' || hex(id) END
    FROM ids`;
  yield* insertMinutes(1, KEPT_MINUTES + EXPIRED_MINUTES);
}).pipe(inTransaction);

/** The median and the slowest of the timed runs of a statement, in milliseconds. */
interface Timing {
  readonly medianMs: number;
  readonly maxMs: number;
}

/**
 * Times `measured`, running `restore` untimed after each run, and returns the
 * median and the slowest of the runs after the warm-up. `run` is the number of
 * the run, from 0, for a statement that needs new input each time.
 */
const measure = <E, R>(
  measured: (run: number) => Effect.Effect<unknown, E, R>,
  restore: Effect.Effect<unknown, E, R> = Effect.void,
) =>
  Effect.gen(function* () {
    const times: Array<number> = [];
    for (let run = 0; run < WARM_UP_RUNS + RUNS; run++) {
      const started = performance.now();
      yield* measured(run);
      if (run >= WARM_UP_RUNS) times.push(performance.now() - started);
      yield* restore;
    }
    const sorted = times.toSorted((a, b) => a - b);
    const timing: Timing = {
      medianMs: sorted[Math.floor(sorted.length / 2)]!,
      maxMs: sorted.at(-1)!,
    };
    return timing;
  });

/** The query a read asks for, without its page: the client's `limit` and `cursor` are added by `readEveryPage`. */
type HistoryQuery = Omit<RunnerMetricsQuery, "limit" | "cursor">;

/** Reads every page of `query`, each of `MAX_PAGE_LIMIT` points, and returns the pages. */
const readEveryPage = (query: HistoryQuery) =>
  Effect.gen(function* () {
    const service = yield* RunnerMetricsService;
    const pages: Array<Effect.Success<ReturnType<typeof service.query>>> = [];
    let cursor: string | undefined;
    do {
      const read = yield* service.query({
        ...query,
        limit: MAX_PAGE_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      });
      pages.push(read);
      cursor = read.nextCursor;
    } while (cursor !== undefined);
    return pages;
  });

const encodePage = Schema.encodeSync(page(RunnerMetricsPoint));

/**
 * Returns the `since` the desktop app sends on its first read of the last
 * `rangeMs` at `nowMs`: the start of the range, rounded down to a point and
 * moved on by two points, as `readRunnerMetricsHistory` does in client-core.
 */
const findRangeStart = (rangeMs: number, pointMs: number, nowMs: number): string =>
  new Date(Math.floor((nowMs - rangeMs) / pointMs) * pointMs + 2 * pointMs).toISOString();

/** Builds the reads to time at `nowMs`, each with its name and its ceiling in milliseconds. */
const buildReads = (nowMs: number): ReadonlyArray<readonly [string, HistoryQuery, number]> => {
  const hourMs = RUNNER_METRICS_POINT_MS.hour;
  const fiveMinutesMs = RUNNER_METRICS_POINT_MS.fiveMinutes;
  const until = new Date(nowMs).toISOString();
  const runnerId = buildRunnerId(1);
  // The newest point that holds a row: the one the seeded minute before now falls in.
  const newestPointMs = Math.floor((CURRENT_MINUTE_MS - MINUTE_MS) / fiveMinutesMs) * fiveMinutesMs;
  return [
    [
      "Fleet page: every runner, hour points, 7 days",
      { resolution: "hour", since: findRangeStart(7 * DAY_MS, hourMs, nowMs), until },
      EVERY_RUNNER_READ_CEILING_MS,
    ],
    [
      "every runner, hour points, 14 days",
      { resolution: "hour", since: findRangeStart(14 * DAY_MS, hourMs, nowMs), until },
      EVERY_RUNNER_READ_CEILING_MS,
    ],
    [
      "machine page: one runner, five-minute points, 24 hours",
      {
        resolution: "fiveMinutes",
        runnerId,
        since: findRangeStart(DAY_MS, fiveMinutesMs, nowMs),
        until,
      },
      ONE_RUNNER_READ_CEILING_MS,
    ],
    [
      "machine page's nudge: one runner, five-minute points, from the newest",
      { resolution: "fiveMinutes", runnerId, since: new Date(newestPointMs).toISOString(), until },
      ONE_RUNNER_READ_CEILING_MS,
    ],
  ];
};

const format = (timing: Timing) =>
  `median ${timing.medianMs.toFixed(2)} ms, max ${timing.maxMs.toFixed(2)} ms`;

describe.runIf(SPEED_TESTS_ENABLED)("the Runner Metrics history", () => {
  it("with 14 days of 5 runners, reads every page, records a minute and prunes an hour in bounded time", async () => {
    const lines: Array<string> = [];
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed;
        const sql = yield* SqlClient.SqlClient;
        const service = yield* RunnerMetricsService;

        const reads: Array<{ readonly timing: Timing; readonly ceilingMs: number }> = [];
        for (const [name, query, ceilingMs] of buildReads(Date.now())) {
          const pages = yield* readEveryPage(query);
          const points = pages.reduce((sum, read) => sum + read.items.length, 0);
          const bytes = pages.reduce(
            (sum, read) => sum + Buffer.byteLength(JSON.stringify(encodePage(read))),
            0,
          );
          const timing = yield* measure(() => readEveryPage(query));
          reads.push({ timing, ceilingMs });
          lines.push(
            `  ${name}: ${String(pages.length)} pages, ${String(points)} points, ` +
              `${String(bytes)} bytes, ${format(timing)}`,
          );
        }

        // Each run records a minute that has no row yet, as the report of a
        // new minute does. The minutes are after the seeded ones.
        const metrics = { diskFreeBytes: 150_000_000_000, availableMemoryBytes: 8_000_000_000 };
        const record = yield* measure((run) =>
          withTransaction(
            sql,
            service.record(
              buildRunnerId(1),
              { ...metrics, cpu: { averagePercent: 12.5, peakPercent: 40 } },
              new Date(CURRENT_MINUTE_MS + run * MINUTE_MS + 30_000).toISOString(),
            ),
          ),
        );
        lines.push(`  record of one runner's minute: ${format(record)}`);
        const recorded = yield* sql<{
          readonly sessions_running: number;
          readonly sessions_queued: number;
        }>`
          SELECT sessions_running, sessions_queued FROM runner_metrics
          WHERE minute = ${CURRENT_MINUTE_MS}`;

        // After each run, the hour past the retention is written again, so
        // each prune deletes 300 rows.
        const expired = insertMinutes(KEPT_MINUTES + 1, KEPT_MINUTES + EXPIRED_MINUTES).pipe(
          inTransaction,
        );
        const pruneAt = new Date(CURRENT_MINUTE_MS).toISOString();
        const prune = yield* measure(() => service.prune(pruneAt), expired);
        lines.push(
          `  prune of ${String(RUNNERS * EXPIRED_MINUTES)} expired rows: ${format(prune)}`,
        );
        const remaining = yield* sql<{ readonly rows: number }>`
          SELECT COUNT(*) AS rows FROM runner_metrics`;

        return { reads, record, recorded, prune, remainingRows: remaining[0]!.rows };
      }).pipe(
        Effect.provideService(CurrentActor, USER),
        Effect.provide(
          RunnerMetricsServiceLayer.pipe(
            Layer.provideMerge(SettingsLayer),
            Layer.provideMerge(TestDatabase),
          ),
        ),
      ),
    );

    process.stderr.write(
      `Runner Metrics, 5 runners with 14 days of minutes, median and max of ${String(RUNS)}:\n` +
        lines.join("\n") +
        "\n",
    );
    expect(result.recorded).toEqual([{ sessions_running: 3, sessions_queued: 1 }]);
    // The seeded rows and the minutes the record runs wrote: each prune
    // deleted only the expired hour, which was then written again.
    expect(result.remainingRows).toBe(
      RUNNERS * (KEPT_MINUTES + EXPIRED_MINUTES) + WARM_UP_RUNS + RUNS,
    );
    for (const { timing, ceilingMs } of result.reads) {
      expect(timing.medianMs).toBeLessThan(ceilingMs);
    }
    expect(result.record.medianMs).toBeLessThan(WRITE_CEILING_MS);
    expect(result.prune.medianMs).toBeLessThan(WRITE_CEILING_MS);
  });
});
