/**
 * Times Tracking's reads against a database arranged as production arranges
 * one, and prints the medians. Run it with `pnpm test:speed`.
 *
 * It is opt-in, and not part of `pnpm test` or CI, because time depends on the
 * machine. The database is the test database every controller test uses: a
 * file in a temporary folder, in WAL mode, with a writer and a read-only
 * reader (ADR 0004, amendment of 2026-10-18), not SQLite's in-memory mode. It
 * is seeded with a migrated schema and no statistics, as a controller starts.
 *
 * It times the real statements, through the real services:
 *
 * - `task.queryTracking`: the whole read, which is what the desktop app sends
 *   on every push of the `task` and `run` topics;
 * - its two halves, the tracked Tasks and the newest runs of those Tasks;
 * - the Task lookup of a handoff, and so of the describe line of every Hand to
 *   an agent answer on To do.
 *
 * Each case seeds 10 or 1,000 tracked Tasks. A Task has between 1 and 50 runs,
 * so a case holds about 25 runs for every Task, and the newest run of a Task
 * is completed, failed at a step, cancelled or running in turn. Three more
 * cases add one kind of history each to 1,000 tracked Tasks, because Tracking
 * must follow the Tasks that are active, not the work ever handed off:
 *
 * - 100,000 handoffs on a Task that is done;
 * - 10,000 in-progress Tasks that have no handoff;
 * - 10,000 handoffs on one tracked Task.
 *
 * What it guards is an order of magnitude: the read looks up each tracked
 * Task's newest runs and newest handoffs, so its time follows the number of
 * Tasks that are in progress, not the history behind them. The ceiling is far
 * above what the read takes and far below a read of every run or handoff.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MAX_TRACKING_HANDOFFS } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { TaskTrackingRunsLayer } from "../daemon/runs";
import { inTransaction, TestDatabase } from "../db/testing";
import { findTaskToContinue } from "../signals";
import { runRepository } from "../runs/repository";
import { taskRepository } from "./repository";
import { TaskTracking, TaskTrackingLayer } from "./tracking";

/** Set to "1" by `pnpm test:speed`. */
const SPEED_TESTS_ENABLED = process.env["RUN_SPEED_TESTS"] === "1";

/** The most time the whole read may take at 1,000 Tasks, in milliseconds. */
const CEILING_MS = 100;

/** How often each read is timed after it has warmed up. */
const RUNS = 25;
const WARM_UP_RUNS = 5;

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/** SQL for the id of Task `i` as 32 hex digits: a version 7 UUID that holds `i`. */
const TASK_ID = "printf('%08x000070008000%012x', i, 0)";

/** SQL for the id of run `k` of Task `i`. */
const RUN_ID = "printf('%08x000070008001%012x', i, k)";

/** SQL for the id of the newest run of Task `i`, which is its run `1 + (i % 50)`. */
const NEWEST_RUN_ID = "printf('%08x000070008001%012x', i, 1 + (i % 50))";

/**
 * Writes `count` in-progress Tasks, each with a handoff entry and a ref, and
 * for Task `i` between 1 and 50 runs, in one transaction. Generated in SQL, so
 * seeding 25,000 runs takes a moment. The ids are UUIDs made of `i` and `k`.
 */
const seed = (count: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
      INSERT INTO tasks (id, title, description, status, priority, labels, created_at, updated_at,
                         status_changed_at)
      SELECT ${sql.literal(`unhex(${TASK_ID})`)}, 'Task ' || i, '', 'in-progress', 'normal', '[]',
             '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z'
      FROM n`;
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
      INSERT INTO task_provenance (id, task_id, ref, event_id, run_id, signal_id, at, actor)
      SELECT randomblob(16), ${sql.literal(`unhex(${TASK_ID})`)}, 'github:issue:acme/api#' || i, 1,
             randomblob(16), randomblob(16), '2026-10-20T10:00:00.000Z', 'user'
      FROM n`;
    // The k-th run of Task i is k minutes after 10:00; the last one is the newest.
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count}),
           m(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM m WHERE k < 50)
      INSERT INTO runs (id, plan, inputs, origin, task_id, status, failure_reason, failed_step_id,
                        created_at, started_at, finished_at)
      SELECT ${sql.literal(`unhex(${RUN_ID})`)}, '{"name":"Implement"}', '{}',
             '{"kind":"manual","actor":"user"}', ${sql.literal(`unhex(${TASK_ID})`)},
             CASE WHEN k < 1 + (i % 50) THEN 'completed'
                  ELSE CASE i % 4 WHEN 0 THEN 'completed' WHEN 1 THEN 'failed'
                                  WHEN 2 THEN 'cancelled' ELSE 'running' END END,
             CASE WHEN k = 1 + (i % 50) AND i % 4 = 1 THEN 'step-failed' END,
             CASE WHEN k = 1 + (i % 50) AND i % 4 = 1 THEN 'work' END,
             printf('2026-10-20T11:%02d:00.000Z', k - 1), printf('2026-10-20T11:%02d:00.000Z', k - 1),
             CASE WHEN k < 1 + (i % 50) OR i % 4 <> 3
                  THEN printf('2026-10-20T11:%02d:30.000Z', k - 1) END
      FROM n JOIN m ON m.k <= 1 + (i % 50)`;
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
      INSERT INTO run_steps (run_id, step_id, iteration, status, error, created_at, started_at,
                             finished_at)
      SELECT ${sql.literal(`unhex(${NEWEST_RUN_ID})`)}, 'work', 1, 'failed',
             '{"code":"denied","message":"permission denied on ops-db"}',
             '2026-10-20T11:00:00.000Z', '2026-10-20T11:00:00.000Z', '2026-10-20T11:00:30.000Z'
      FROM n WHERE i % 4 = 1`;
  }).pipe(inTransaction);

/** The history a case adds to the tracked Tasks. */
interface History {
  /** Handoffs on one Task that is done. */
  readonly doneHandoffs?: number;
  /** In-progress Tasks with no handoff. */
  readonly unrelatedActive?: number;
  /** Handoffs added to the first tracked Task, on top of its own. */
  readonly extraHandoffsOnOne?: number;
}

/**
 * Writes the history of `history` in one transaction, beside `count` tracked
 * Tasks. The Task that is done and the unrelated Tasks take the ids after the
 * tracked Tasks'.
 */
const seedHistory = (count: number, history: History) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { doneHandoffs = 0, unrelatedActive = 0, extraHandoffsOnOne = 0 } = history;
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT ${count + 1} UNION ALL SELECT i + 1 FROM n
                              WHERE i < ${count + 1 + unrelatedActive})
      INSERT INTO tasks (id, title, description, status, priority, labels, created_at, updated_at,
                         status_changed_at)
      SELECT ${sql.literal(`unhex(${TASK_ID})`)}, 'Other ' || i, '',
             CASE WHEN i = ${count + 1} THEN 'done' ELSE 'in-progress' END, 'normal', '[]',
             '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z'
      FROM n`;
    // The handoffs of the done Task and the extra ones of the first tracked
    // Task are one second apart, the extra ones after the Task's own.
    yield* sql`
      WITH RECURSIVE n(j) AS (SELECT 1 UNION ALL SELECT j + 1 FROM n WHERE j < ${doneHandoffs})
      INSERT INTO task_provenance (id, task_id, run_id, signal_id, at, actor)
      SELECT randomblob(16), unhex(printf('%08x000070008000%012x', ${count + 1}, 0)),
             randomblob(16), randomblob(16),
             strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-19', '+' || j || ' seconds'), 'user'
      FROM n`;
    yield* sql`
      WITH RECURSIVE n(j) AS (SELECT 1 UNION ALL SELECT j + 1 FROM n WHERE j < ${extraHandoffsOnOne})
      INSERT INTO task_provenance (id, task_id, run_id, signal_id, at, actor)
      SELECT randomblob(16), unhex(printf('%08x000070008000%012x', 1, 0)),
             randomblob(16), randomblob(16),
             strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-21', '+' || j || ' seconds'), 'user'
      FROM n`;
  }).pipe(inTransaction);

/** Times `read` and returns its median in milliseconds. */
const measureMedian = <A, E, R>(read: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const times: Array<number> = [];
    for (let run = 0; run < WARM_UP_RUNS + RUNS; run++) {
      const started = performance.now();
      yield* read;
      if (run >= WARM_UP_RUNS) times.push(performance.now() - started);
    }
    return times.toSorted((a, b) => a - b)[Math.floor(times.length / 2)]!;
  });

const CASES: ReadonlyArray<readonly [string, number, History]> = [
  ["10 tracked Tasks", 10, {}],
  ["1,000 tracked Tasks", 1000, {}],
  ["1,000 tracked Tasks, 100,000 handoffs on a done Task", 1000, { doneHandoffs: 100_000 }],
  ["1,000 tracked Tasks, 10,000 unrelated in-progress Tasks", 1000, { unrelatedActive: 10_000 }],
  ["1,000 tracked Tasks, 10,000 handoffs on one", 1000, { extraHandoffsOnOne: 10_000 }],
];

describe.runIf(SPEED_TESTS_ENABLED)("Tracking's reads", () => {
  it.each(CASES)("with %s, and up to 50 runs each", async (name, count, history) => {
    const medians = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed(count);
        yield* seedHistory(count, history);
        const tasks = yield* taskRepository;
        const runs = yield* runRepository;
        const tracking = yield* TaskTracking;
        const ids = (yield* tasks.listTracked()).map((task) => task.id);
        const rows = (yield* tracking.query()).rows;
        return {
          rows: rows.length,
          mostHandoffs: Math.max(...rows.map((row) => row.handoffs.length)),
          replyBytes: JSON.stringify(rows).length,
          queryTracking: yield* measureMedian(tracking.query()),
          trackedTasks: yield* measureMedian(tasks.listTracked()),
          newestRuns: yield* measureMedian(runs.listLatestOfTasks(ids)),
          taskLookup: yield* measureMedian(
            findTaskToContinue(tasks, `github:issue:acme/api#${String(count)}`),
          ),
        };
      }).pipe(
        Effect.provideService(CurrentActor, USER),
        Effect.provide(
          TaskTrackingLayer.pipe(
            Layer.provideMerge(TaskTrackingRunsLayer),
            Layer.provideMerge(TestDatabase),
          ),
        ),
      ),
    );

    const format = (ms: number) => `${ms.toFixed(2)} ms`;
    process.stderr.write(
      [
        `${name} (${String(medians.rows)} rows, ${String(medians.replyBytes)} bytes), median of ${String(RUNS)}:`,
        `  task.queryTracking, whole read  ${format(medians.queryTracking)}`,
        `  tracked Tasks and handoffs      ${format(medians.trackedTasks)}`,
        `  newest runs of those Tasks      ${format(medians.newestRuns)}`,
        `  handoff's Task lookup           ${format(medians.taskLookup)}`,
      ].join("\n") + "\n",
    );
    expect(medians.rows).toBe(count);
    expect(medians.mostHandoffs).toBeLessThanOrEqual(MAX_TRACKING_HANDOFFS);
    if (count === 1000) expect(medians.queryTracking).toBeLessThan(CEILING_MS);
  });
});
