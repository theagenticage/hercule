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
 *   an agent answer on To do;
 * - `task.readTracking`, which the desktop app sends when a row's pane opens:
 *   on one Task with a long history, a plan of many steps and a 1 MB output,
 *   and on a Task whose newest output has 12 keys of 100,000 characters (the
 *   last two cases below).
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
 * Two more cases time `task.queryLegs` on the legs of 50 handoffs (a page of
 * Done signals): each on its own Task of 100 handoffs and 100 runs, and one
 * with 200 re-runs, half of them a chain of re-runs of re-runs; and all 50 on
 * one Task of 10,000 handoffs, because finding a handoff and the one after it
 * must not walk the Task's handoffs.
 *
 * What it guards is an order of magnitude: the read looks up each tracked
 * Task's newest runs and newest handoffs, so its time follows the number of
 * Tasks that are in progress, not the history behind them. The ceiling is far
 * above what the read takes and far below a read of every run or handoff.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  MAX_LEG_QUERY_RUNS,
  MAX_TRACKING_DETAIL_RUNS,
  MAX_TRACKING_HANDOFFS,
  MAX_TRACKING_OUTPUT_FIELDS,
  MAX_TRACKING_OUTPUT_LABEL,
  MAX_TRACKING_STEP_NAME,
} from "@hercule/contract";
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
 * Writes `count` in-progress Tasks, each with a handoff entry that names the
 * Task's first run and a ref, and for Task `i` between 1 and 50 runs, in one
 * transaction. Generated in SQL, so
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
             ${sql.literal(`unhex(printf('%08x000070008001%012x', i, 1))`)}, randomblob(16),
             '2026-10-20T10:00:00.000Z', 'user'
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

/** The runs `seedPaneHistory` adds to the first tracked Task. */
const PANE_RUNS = 1000;

/** The steps of the plan of each of those runs. */
const PANE_PLAN_STEPS = 50;

/**
 * The runs before the newest that `seedPaneHistory` gives loop iterations, and
 * how many extra iterations of its agent step each one has. Each iteration
 * has a session and a `LOOP_OUTPUT_CHARACTERS` characters output, so a read
 * that walks past the outputs of the pane's runs shows up here.
 */
const LOOP_RUNS = MAX_TRACKING_DETAIL_RUNS - 1;
const LOOP_ITERATIONS = 20;
const LOOP_OUTPUT_CHARACTERS = 50_000;

/** The most time the pane's read may take, in milliseconds. */
const PANE_CEILING_MS = 50;

/** The most bytes the pane's reply may hold. A pane's text and fields are cut well below it. */
const PANE_REPLY_CEILING_BYTES = 20_000;

/**
 * Adds `PANE_RUNS` completed runs to the first tracked Task, each with a plan
 * of `PANE_PLAN_STEPS` steps and an agent step that completed with a session
 * and a small output, then an action step that finished later. The newest
 * run's agent step has a 1 MB text output. They are newer than the runs
 * `seed` wrote. The `LOOP_RUNS` runs before the newest also ran their agent
 * step `LOOP_ITERATIONS` more times, as a loop does, each with a session and a
 * large output. Written in SQL, in one transaction.
 */
const seedPaneHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const plan = `(SELECT json_object('name', 'Implement', 'steps', json_group_array(json_object(
                   'id', 's' || j, 'kind', CASE WHEN j = 1 THEN 'agent' ELSE 'action' END,
                   'action', 'github/open-pr', 'prompt', 'Do the work and report what you did')))
                 FROM (WITH RECURSIVE m(j) AS (SELECT 1 UNION ALL SELECT j + 1 FROM m
                                                WHERE j < ${PANE_PLAN_STEPS})
                       SELECT j FROM m))`;
  yield* sql`
    WITH RECURSIVE m(k) AS (SELECT 101 UNION ALL SELECT k + 1 FROM m WHERE k < ${100 + PANE_RUNS})
    INSERT INTO runs (id, plan, inputs, origin, task_id, status, created_at, started_at, finished_at)
    SELECT ${sql.literal(`unhex(printf('%08x000070008001%012x', 1, k))`)}, ${sql.literal(plan)}, '{}',
           '{"kind":"manual","actor":"user"}', unhex(printf('%08x000070008000%012x', 1, 0)),
           'completed', strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-21', '+' || k || ' seconds'),
           strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-21', '+' || k || ' seconds'),
           strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-21', '+' || k || ' seconds')
    FROM m`;
  yield* sql`
    WITH RECURSIVE m(k) AS (SELECT 101 UNION ALL SELECT k + 1 FROM m WHERE k < ${100 + PANE_RUNS})
    INSERT INTO run_steps (run_id, step_id, iteration, status, output, session_id, created_at,
                           started_at, finished_at)
    SELECT unhex(printf('%08x000070008001%012x', 1, k)), 's1', 1, 'completed',
           CASE WHEN k = ${100 + PANE_RUNS}
                THEN json_object('text', replace(hex(zeroblob(200000)), '00', 'word '),
                                 'exitStatus', 'completed')
                ELSE '{"text":"Done","exitStatus":"completed"}' END,
           randomblob(16), '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z',
           '2026-10-21T00:00:01.000Z'
    FROM m`;
  yield* sql`
    WITH RECURSIVE m(k) AS (SELECT 101 UNION ALL SELECT k + 1 FROM m WHERE k < ${100 + PANE_RUNS})
    INSERT INTO run_steps (run_id, step_id, iteration, status, output, created_at, started_at,
                           finished_at)
    SELECT unhex(printf('%08x000070008001%012x', 1, k)), 's2', 1, 'completed', '{}',
           '2026-10-21T00:00:01.000Z', '2026-10-21T00:00:01.000Z', '2026-10-21T00:00:02.000Z'
    FROM m`;
  yield* sql`
    WITH RECURSIVE m(k) AS (SELECT ${100 + PANE_RUNS - LOOP_RUNS} UNION ALL SELECT k + 1 FROM m
                            WHERE k < ${100 + PANE_RUNS - 1}),
         it(n) AS (SELECT 2 UNION ALL SELECT n + 1 FROM it WHERE n < ${LOOP_ITERATIONS + 1})
    INSERT INTO run_steps (run_id, step_id, iteration, status, output, session_id, created_at,
                           started_at, finished_at)
    SELECT unhex(printf('%08x000070008001%012x', 1, k)), 's1', n, 'completed',
           json_object('text', replace(hex(zeroblob(${LOOP_OUTPUT_CHARACTERS / 5})), '00', 'word ')),
           randomblob(16), '2026-10-21T00:00:00.000Z', printf('2026-10-21T00:00:%02d.000Z', n),
           printf('2026-10-21T00:00:%02d.500Z', n)
    FROM m CROSS JOIN it`;
}).pipe(inTransaction);

/** The output keys `seedLongKeyOutput` writes, and the length of each key. */
const LONG_KEYS = 12;
const LONG_KEY_LENGTH = 100_000;

/**
 * Gives the newest run `seedPaneHistory` wrote an output schema with no
 * `properties`, and an output of `LONG_KEYS` keys of `LONG_KEY_LENGTH`
 * characters each: the labels of its fields then come from the agent's own
 * keys. It also gives its agent step and its ending action step names of
 * `LONG_KEY_LENGTH` characters.
 */
const seedLongKeyOutput = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const newestRun = `unhex(printf('%08x000070008001%012x', 1, ${100 + PANE_RUNS}))`;
  yield* sql`
    UPDATE runs SET plan = json_set(
      plan,
      '$.steps[0].outputSchema', json('{"type":"object"}'),
      '$.steps[0].name', replace(hex(zeroblob(${LONG_KEY_LENGTH})), '00', 'n'),
      '$.steps[1].name', replace(hex(zeroblob(${LONG_KEY_LENGTH})), '00', 'a'))
    WHERE id = ${sql.literal(newestRun)}`;
  yield* sql`
    UPDATE run_steps SET output = (
      SELECT json_group_object(printf('%02d', j) || replace(hex(zeroblob(${LONG_KEY_LENGTH})), '00', 'k'), j)
      FROM (WITH RECURSIVE m(j) AS (SELECT 1 UNION ALL SELECT j + 1 FROM m WHERE j < ${LONG_KEYS})
            SELECT j FROM m))
    WHERE run_id = ${sql.literal(newestRun)} AND step_id = 's1'`;
}).pipe(inTransaction);

describe.runIf(SPEED_TESTS_ENABLED)("the Tracking pane's read", () => {
  it("with a Task of 1,000 runs, a 50-step plan and a 1 MB output, reads in bounded time and replies in bounded size", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed(1);
        yield* seedPaneHistory;
        const tasks = yield* taskRepository;
        const tracking = yield* TaskTracking;
        const taskId = (yield* tasks.listTracked())[0]!.id;
        const detail = yield* tracking.read(taskId);
        return {
          detail,
          replyBytes: JSON.stringify(detail).length,
          readTracking: yield* measureMedian(tracking.read(taskId)),
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

    process.stderr.write(
      `task.readTracking with ${String(PANE_RUNS)} runs and a 1 MB output, ` +
        `${String(result.replyBytes)} bytes, median of ${String(RUNS)}: ` +
        `${result.readTracking.toFixed(2)} ms\n`,
    );
    expect(result.detail.runs).toHaveLength(MAX_TRACKING_DETAIL_RUNS);
    // The first handoff's run is the Task's oldest, far older than the 20 newest.
    expect(result.detail.runs.map((run) => run.id)).not.toContain(result.detail.firstHandoff.runId);
    expect(result.detail.firstHandoff.workflowName).toBe("Implement");
    // The newest run's 1 MB text, cut to the limit.
    expect(result.detail.output).toMatchObject({ kind: "text" });
    expect((result.detail.output as { text: string }).text.length).toBeGreaterThan(900);
    expect(result.detail.endingActionStepName).toBe("github/open-pr");
    expect(result.replyBytes).toBeLessThan(PANE_REPLY_CEILING_BYTES);
    expect(result.readTracking).toBeLessThan(PANE_CEILING_MS);
  });

  it("with a newest output of 12 keys of 100,000 characters each, cuts the labels and step names and replies in bounded size", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed(1);
        yield* seedPaneHistory;
        yield* seedLongKeyOutput;
        const tasks = yield* taskRepository;
        const tracking = yield* TaskTracking;
        const taskId = (yield* tasks.listTracked())[0]!.id;
        const detail = yield* tracking.read(taskId);
        return {
          detail,
          replyBytes: JSON.stringify(detail).length,
          readTracking: yield* measureMedian(tracking.read(taskId)),
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

    process.stderr.write(
      `task.readTracking with ${String(LONG_KEYS)} output keys of ${String(LONG_KEY_LENGTH)} characters, ` +
        `${String(result.replyBytes)} bytes, median of ${String(RUNS)}: ` +
        `${result.readTracking.toFixed(2)} ms\n`,
    );
    const output = result.detail.output;
    expect(output?.kind).toBe("fields");
    const fields = output?.kind === "fields" ? output.fields : [];
    expect(fields).toHaveLength(Math.min(LONG_KEYS, MAX_TRACKING_OUTPUT_FIELDS));
    for (const field of fields) {
      expect(field.label.length).toBeLessThanOrEqual(MAX_TRACKING_OUTPUT_LABEL);
    }
    expect(output?.stepName).toHaveLength(MAX_TRACKING_STEP_NAME);
    expect(result.detail.endingActionStepName).toHaveLength(MAX_TRACKING_STEP_NAME);
    expect(result.replyBytes).toBeLessThan(PANE_REPLY_CEILING_BYTES);
    expect(result.readTracking).toBeLessThan(PANE_CEILING_MS);
  });
});

/** The handoffs asked for: one for each of this many Tasks, which is a page of Done signals. */
const LEG_TASKS = MAX_LEG_QUERY_RUNS;

/** The handoffs of each Task, each with a run of its own. */
const LEG_HANDOFFS_PER_TASK = 100;

/** The handoff asked for on each Task, the middle one, so the Task has handoffs before and after it. */
const LEG_ASKED_HANDOFF = 50;

/** The runs that re-run the asked handoff of the first Task: a chain of half, the rest direct. */
const LEG_RERUNS = 200;

/** The most time `task.queryLegs` may take, in milliseconds. */
const LEGS_CEILING_MS = 50;

/**
 * Writes `LEG_TASKS` Tasks with `LEG_HANDOFFS_PER_TASK` handoffs each, a run
 * for every handoff, and `LEG_RERUNS` runs that re-run the asked handoff of
 * the first Task. In SQL, in one transaction.
 */
const seedLegs = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const askedRun = `unhex(printf('%08x000070008001%012x', 1, ${LEG_ASKED_HANDOFF}))`;
  yield* sql`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${LEG_TASKS})
    INSERT INTO tasks (id, title, description, status, priority, labels, created_at, updated_at,
                       status_changed_at)
    SELECT ${sql.literal(`unhex(${TASK_ID})`)}, 'Task ' || i, '', 'in-progress', 'normal', '[]',
           '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z'
    FROM n`;
  yield* sql`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${LEG_TASKS}),
         m(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM m WHERE k < ${LEG_HANDOFFS_PER_TASK})
    INSERT INTO task_provenance (id, task_id, run_id, signal_id, at, actor)
    SELECT randomblob(16), ${sql.literal(`unhex(${TASK_ID})`)}, ${sql.literal(`unhex(${RUN_ID})`)},
           randomblob(16), strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-20', '+' || k || ' seconds'), 'user'
    FROM n JOIN m`;
  yield* sql`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${LEG_TASKS}),
         m(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM m WHERE k < ${LEG_HANDOFFS_PER_TASK})
    INSERT INTO runs (id, plan, inputs, origin, task_id, status, created_at, started_at, finished_at)
    SELECT ${sql.literal(`unhex(${RUN_ID})`)}, '{"name":"Implement"}', '{}',
           '{"kind":"manual","actor":"user"}', ${sql.literal(`unhex(${TASK_ID})`)}, 'completed',
           strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-20', '+' || k || ' seconds'),
           strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-20', '+' || k || ' seconds'),
           strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-20', '+' || k || ' seconds')
    FROM n JOIN m`;
  // Re-run r of the asked handoff: the first half re-run the one before (a chain), the rest the handoff's run.
  yield* sql`
    WITH RECURSIVE r(j) AS (SELECT 1 UNION ALL SELECT j + 1 FROM r WHERE j < ${LEG_RERUNS})
    INSERT INTO runs (id, plan, inputs, origin, task_id, original_run_id, status, created_at,
                      started_at, finished_at)
    SELECT unhex(printf('%08x000070008002%012x', 1, j)), '{"name":"Implement"}', '{}',
           '{"kind":"manual","actor":"user"}', unhex(printf('%08x000070008000%012x', 1, 0)),
           CASE WHEN j = 1 OR j > ${LEG_RERUNS / 2} THEN ${sql.literal(askedRun)}
                ELSE unhex(printf('%08x000070008002%012x', 1, j - 1)) END,
           'completed', strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-21', '+' || j || ' seconds'),
           strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-21', '+' || j || ' seconds'),
           strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-21', '+' || j || ' seconds')
    FROM r`;
}).pipe(inTransaction);

describe.runIf(SPEED_TESTS_ENABLED)("the legs read", () => {
  it("with 50 handoffs on Tasks of 100 handoffs and one leg of 200 re-runs, reads in bounded time and replies in bounded size", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedLegs;
        const tracking = yield* TaskTracking;
        // The ids are the ones the seed wrote: Task i's handoff run k, as a UUID.
        const askedRunIds = Array.from(
          { length: LEG_TASKS },
          (_, index) =>
            `${(index + 1).toString(16).padStart(8, "0")}-0000-7000-8001-${LEG_ASKED_HANDOFF.toString(16).padStart(12, "0")}`,
        );
        const { legs } = yield* tracking.queryLegs(askedRunIds);
        return {
          legs,
          replyBytes: JSON.stringify(legs).length,
          queryLegs: yield* measureMedian(tracking.queryLegs(askedRunIds)),
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

    process.stderr.write(
      `task.queryLegs with ${String(LEG_TASKS)} handoffs, Tasks of ${String(LEG_HANDOFFS_PER_TASK)} handoffs ` +
        `and a leg of ${String(LEG_RERUNS)} re-runs, ${String(result.replyBytes)} bytes, median of ${String(RUNS)}: ` +
        `${result.queryLegs.toFixed(2)} ms\n`,
    );
    expect(result.legs).toHaveLength(LEG_TASKS);
    expect(result.legs[0]).toMatchObject({ rerunCount: LEG_RERUNS });
    expect(result.legs[1]).toMatchObject({ rerunCount: 0 });
    expect(result.legs.every((leg) => leg.next !== undefined)).toBe(true);
    expect(result.queryLegs).toBeLessThan(LEGS_CEILING_MS);
  });
});

/** The handoffs of the one Task of the long-history case, each with a run of its own. */
const LONG_TASK_HANDOFFS = 10_000;

/** The most time `task.queryLegs` may take on the long-history case, in milliseconds. */
const LONG_TASK_LEGS_CEILING_MS = 10;

/**
 * Writes one Task with `LONG_TASK_HANDOFFS` handoffs, a run for every
 * handoff. In SQL, in one transaction. The Task and its runs take the ids of
 * Task 1.
 */
const seedLongTask = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO tasks (id, title, description, status, priority, labels, created_at, updated_at,
                       status_changed_at)
    SELECT unhex(printf('%08x000070008000%012x', 1, 0)), 'Task 1', '', 'in-progress', 'normal', '[]',
           '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z'`;
  yield* sql`
    WITH RECURSIVE m(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM m WHERE k < ${LONG_TASK_HANDOFFS})
    INSERT INTO task_provenance (id, task_id, run_id, signal_id, at, actor)
    SELECT randomblob(16), unhex(printf('%08x000070008000%012x', 1, 0)),
           unhex(printf('%08x000070008001%012x', 1, k)), randomblob(16),
           strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-20', '+' || k || ' seconds'), 'user'
    FROM m`;
  yield* sql`
    WITH RECURSIVE m(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM m WHERE k < ${LONG_TASK_HANDOFFS})
    INSERT INTO runs (id, plan, inputs, origin, task_id, status, created_at, started_at, finished_at)
    SELECT unhex(printf('%08x000070008001%012x', 1, k)), '{"name":"Implement"}', '{}',
           '{"kind":"manual","actor":"user"}', unhex(printf('%08x000070008000%012x', 1, 0)),
           'completed', strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-20', '+' || k || ' seconds'),
           strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-20', '+' || k || ' seconds'),
           strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-20', '+' || k || ' seconds')
    FROM m`;
}).pipe(inTransaction);

describe.runIf(SPEED_TESTS_ENABLED)("the legs read on a long history", () => {
  it("with 50 handoffs on one Task of 10,000 handoffs, finds each handoff and the next without walking the Task", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seedLongTask;
        const tracking = yield* TaskTracking;
        // Every 200th handoff's run, so the asked handoffs are spread over the Task's whole history.
        const askedRunIds = Array.from(
          { length: MAX_LEG_QUERY_RUNS },
          (_, index) =>
            `00000001-0000-7000-8001-${((index + 1) * (LONG_TASK_HANDOFFS / MAX_LEG_QUERY_RUNS)).toString(16).padStart(12, "0")}`,
        );
        const { legs } = yield* tracking.queryLegs(askedRunIds);
        return { legs, queryLegs: yield* measureMedian(tracking.queryLegs(askedRunIds)) };
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

    process.stderr.write(
      `task.queryLegs with ${String(MAX_LEG_QUERY_RUNS)} handoffs on one Task of ${String(LONG_TASK_HANDOFFS)} handoffs, ` +
        `median of ${String(RUNS)}: ${result.queryLegs.toFixed(2)} ms\n`,
    );
    expect(result.legs).toHaveLength(MAX_LEG_QUERY_RUNS);
    // Every asked handoff but the Task's newest has a next one.
    expect(result.legs.filter((leg) => leg.next === undefined)).toHaveLength(1);
    expect(result.queryLegs).toBeLessThan(LONG_TASK_LEGS_CEILING_MS);
  });
});
