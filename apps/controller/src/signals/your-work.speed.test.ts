/**
 * Times the Your work read against a database arranged as production arranges
 * one, and prints the medians. Run it with `pnpm test:speed`.
 *
 * It is opt-in, and not part of `pnpm test` or CI, because time depends on the
 * machine. The database is the test database every controller test uses: a
 * file in a temporary folder, in WAL mode, with a writer and a read-only
 * reader (ADR 0004, amendment of 2026-10-18), not SQLite's in-memory mode. It
 * is seeded with a migrated schema and no statistics, as a controller starts.
 *
 * It times `signal.queryYourWork`, the whole read, and its two statements.
 * Each case has 200 open signals, and 1,000 open Tasks that each link 50
 * refs, one for each of 50 refs. Task `i` links the refs of the signals `i` to
 * `i + 49`. Every link has the same time, so the active Task of a ref is the
 * lowest Task id that links it: the ref of the signal `r` has the Task
 * `max(1, r - 49)`. So the Tasks 1 to 151 are each the active Task of one or
 * more open signals, and the read returns 151 rows.
 * Three more cases add one kind of history each, because the read must follow
 * the open signals and the Tasks that match them, not the signals and Tasks ever
 * written:
 *
 * - 20,000 resolved signals;
 * - 20,000 open Tasks that match no signal;
 * - 20,000 done Tasks that link the refs of the open signals.
 *
 * What it guards is an order of magnitude: the ceiling is far above what the
 * read takes and far below a read of every Task or every link.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { CurrentActor, type Actor } from "../actor";
import { inTransaction, TestDatabase } from "../db/testing";
import { taskRepository } from "../tasks";
import { signalRepository } from "./repository";
import { YourWork, YourWorkLayer } from "./your-work";

/** Set to "1" by `pnpm test:speed`. */
const SPEED_TESTS_ENABLED = process.env["RUN_SPEED_TESTS"] === "1";

/** The most time the whole read may take at 1,000 Tasks, in milliseconds. */
const CEILING_MS = 100;

/** How often each read is timed after it has warmed up. */
const RUNS = 25;
const WARM_UP_RUNS = 5;

const OPEN_SIGNALS = 200;
const TASKS = 1000;
const REFS_PER_TASK = 50;
/** The Tasks that are the active Task of at least one open signal; see the module comment. */
const ACTIVE_TASKS = OPEN_SIGNALS - REFS_PER_TASK + 1;
const AT = "2026-10-20T10:00:00.000Z";

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/** SQL for the id of signal `i` as 32 hex digits: a version 7 UUID that holds `i`. */
const SIGNAL_ID = "printf('%08x000070008000%012x', i, 0)";

/** SQL for the id of Task `i`. */
const TASK_ID = "printf('%08x000070008001%012x', i, 0)";

/** The history a case adds. */
interface History {
  readonly resolvedSignals?: number;
  /** Open Tasks that carry refs no signal has. */
  readonly unrelatedOpenTasks?: number;
  /** Done Tasks that link the refs of the open signals. */
  readonly doneTasksOnRefs?: number;
}

/**
 * Writes `count` signals from the number `first` on. The signal `first + j`
 * is on the thread `github:pr:acme/api#(refBase + j)`.
 */
const insertSignals = (
  first: number,
  count: number,
  status: "open" | "resolved",
  refBase: number,
) =>
  Effect.gen(function* () {
    if (count === 0) return;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT ${first} UNION ALL SELECT i + 1 FROM n WHERE i < ${first + count - 1})
      INSERT INTO signals (id, kind, origin, title, priority, blocks, actions, match, status,
                           resolution, created_at, connection_id, thread_ref)
      SELECT ${sql.literal(`unhex(${SIGNAL_ID})`)}, 'github/review-requested',
             '{"type":"event","eventId":1,"connectionId":"x","threadRef":"x"}',
             'Review requested', 'normal', '[]', '[]', '{}', ${status},
             ${status === "open" ? null : '{"kind":"decided","actionId":"done","outcome":"Done","actor":"user","origin":"web","at":"2026-10-20T10:00:00.000Z"}'},
             ${AT}, randomblob(16), 'github:pr:acme/api#' || (${refBase} + i - ${first})
      FROM n`;
  });

/**
 * Writes `count` Tasks from the number `first` on, with `status`, and for
 * each Task 50 links. A done Task is at the stage `done`, which is not live.
 * The refs of the Task `first + j` are
 * `github:pr:acme/api#(refBase + j + k)` for k from 0 to 49.
 */
const insertTasks = (first: number, count: number, status: "open" | "done", refBase: number) =>
  Effect.gen(function* () {
    if (count === 0) return;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT ${first} UNION ALL SELECT i + 1 FROM n WHERE i < ${first + count - 1})
      INSERT INTO tasks (id, title, description, status, stage, priority, labels, created_at,
                         updated_at, status_changed_at)
      SELECT ${sql.literal(`unhex(${TASK_ID})`)}, 'Task ' || i, 'A long description ' || i,
             ${status}, ${status === "done" ? "done" : "planned"}, 'normal', '[]', ${AT}, strftime('%Y-%m-%dT%H:%M:%fZ', ${AT}, '+' || i || ' seconds'), ${AT}
      FROM n`;
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT ${first} UNION ALL SELECT i + 1 FROM n WHERE i < ${first + count - 1}),
           m(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM m WHERE k < ${REFS_PER_TASK - 1})
      INSERT INTO task_entity_links (task_id, ref, linked_at, linked_by, following)
      SELECT ${sql.literal(`unhex(${TASK_ID})`)}, 'github:pr:acme/api#' || (${refBase} + i - ${first} + k), ${AT}, 'user', 0
      FROM n JOIN m`;
  });

/** Writes the signals and Tasks of a case, in one transaction. */
const seed = (history: History) =>
  Effect.gen(function* () {
    const { resolvedSignals = 0, unrelatedOpenTasks = 0, doneTasksOnRefs = 0 } = history;
    yield* insertSignals(1, OPEN_SIGNALS, "open", 1);
    yield* insertTasks(1, TASKS, "open", 1);
    // The resolved signals and the done Tasks are on the same refs as the
    // open signals, so only their status keeps them out of Your work.
    yield* insertSignals(1_000_000, resolvedSignals, "resolved", 1);
    yield* insertTasks(2_000_000, unrelatedOpenTasks, "open", 5_000_000);
    yield* insertTasks(3_000_000, doneTasksOnRefs, "done", 1);
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

const CASES: ReadonlyArray<readonly [string, History]> = [
  ["200 open signals, 1,000 Tasks", {}],
  ["200 open signals, 1,000 Tasks, 20,000 resolved signals", { resolvedSignals: 20_000 }],
  ["200 open signals, 1,000 Tasks, 20,000 unrelated open Tasks", { unrelatedOpenTasks: 20_000 }],
  ["200 open signals, 1,000 Tasks, 20,000 done Tasks", { doneTasksOnRefs: 20_000 }],
];

describe.runIf(SPEED_TESTS_ENABLED)("Your work's read", () => {
  it.each(CASES)("with %s, each with 50 links", async (name, history) => {
    const medians = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed(history);
        const signals = yield* signalRepository;
        const tasks = yield* taskRepository;
        const yourWork = yield* YourWork;
        const rows = (yield* yourWork.query()).tasks;
        const threads = yield* signals.listOpenThreads();
        const refs = threads.map((thread) => thread.threadRef);
        return {
          rows: rows.length,
          replyBytes: JSON.stringify(rows).length,
          queryYourWork: yield* measureMedian(yourWork.query()),
          openThreads: yield* measureMedian(signals.listOpenThreads()),
          openTasks: yield* measureMedian(tasks.listActiveTasksForRefs(refs)),
        };
      }).pipe(
        Effect.provideService(CurrentActor, USER),
        Effect.provide(YourWorkLayer.pipe(Layer.provideMerge(TestDatabase))),
      ),
    );

    const format = (ms: number) => `${ms.toFixed(2)} ms`;
    process.stderr.write(
      [
        `${name} (${String(medians.rows)} rows, ${String(medians.replyBytes)} bytes), median of ${String(RUNS)}:`,
        `  signal.queryYourWork, whole read  ${format(medians.queryYourWork)}`,
        `  thread refs of the open signals   ${format(medians.openThreads)}`,
        `  open Tasks on those refs          ${format(medians.openTasks)}`,
      ].join("\n") + "\n",
    );
    expect(medians.rows).toBe(ACTIVE_TASKS);
    expect(medians.queryYourWork).toBeLessThan(CEILING_MS);
  });
});
