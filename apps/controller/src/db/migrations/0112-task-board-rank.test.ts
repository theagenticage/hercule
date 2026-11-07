/**
 * Tests what the task board rank migration does to a database at the previous
 * head: every Task gets a rank in its cell, oldest first; a live Task whose
 * newest run failed shows that failure; and a session that is not live takes
 * the time of its last activity as the end of its last turn. The upgrade test
 * in `e2e/` owns the migration of data written by a real binary.
 *
 * The tests of the data stop at this migration, so a later migration cannot
 * change what they check. The test of the index runs on the newest database.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { BOARD_RANK_ALPHABET, chooseRankBetween } from "../../tasks/board-rank";
import { taskRepository } from "../../tasks/repository";
import { runMigrations } from "../migrate";
import { inTransaction, TestDatabase, TestDatabaseWriter } from "../testing";
import { migrations } from "./index";

const BEFORE = migrations.filter(([id]) => id < 112);
const UP_TO_BOARD_RANK = migrations.filter(([id]) => id <= 112);

/** Builds the 16 bytes of a test id, so the id shows in the order of the sorted rows. */
const buildTestId = (name: string): Uint8Array => {
  const bytes = new Uint8Array(16);
  new TextEncoder().encodeInto(name, bytes);
  return bytes;
};

const decodeName = (bytes: Uint8Array): string =>
  new TextDecoder().decode(bytes).replaceAll("\0", "");

const at = (minute: number): string => `2026-11-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

interface TaskRow {
  readonly name: string;
  readonly stage: string;
  readonly status: string;
  readonly minute: number;
  readonly project?: string;
  readonly deleted?: boolean;
}

// The names sort the opposite way to `minute` inside each cell, so a rank that
// followed the id would be wrong.
const TASKS: ReadonlyArray<TaskRow> = [
  { name: "a-newest", stage: "planned", status: "open", minute: 5, project: "p1" },
  { name: "b-deleted", stage: "planned", status: "open", minute: 3, project: "p1", deleted: true },
  { name: "c-oldest", stage: "planned", status: "open", minute: 1, project: "p1" },
  { name: "d-middle", stage: "planned", status: "open", minute: 2, project: "p1" },
  { name: "e-other-stage", stage: "building", status: "in-progress", minute: 4, project: "p1" },
  { name: "f-no-project-2", stage: "planned", status: "open", minute: 7 },
  { name: "g-no-project-1", stage: "planned", status: "open", minute: 6 },
  { name: "h-failed-last", stage: "building", status: "in-progress", minute: 8, project: "p2" },
  { name: "i-failed-then-ok", stage: "building", status: "in-progress", minute: 9, project: "p2" },
  { name: "j-never-ran", stage: "done", status: "done", minute: 10, project: "p2" },
  { name: "k-failed-deleted", stage: "planned", status: "open", minute: 11, deleted: true },
];

const RUNS: ReadonlyArray<{
  readonly name: string;
  readonly task: string;
  readonly status: "completed" | "failed";
  readonly minute: number;
}> = [
  { name: "run-h-ok", task: "h-failed-last", status: "completed", minute: 20 },
  { name: "run-h-failed", task: "h-failed-last", status: "failed", minute: 21 },
  { name: "run-i-failed", task: "i-failed-then-ok", status: "failed", minute: 20 },
  { name: "run-i-ok", task: "i-failed-then-ok", status: "completed", minute: 21 },
  { name: "run-k-failed", task: "k-failed-deleted", status: "failed", minute: 20 },
];

const SESSIONS: ReadonlyArray<{
  readonly name: string;
  readonly status: string;
  readonly minute: number;
}> = [
  { name: "idle", status: "idle", minute: 30 },
  { name: "exited", status: "exited", minute: 31 },
  { name: "busy", status: "busy", minute: 32 },
  { name: "queued", status: "queued", minute: 33 },
];

/** Writes what the previous head stores: Tasks, their runs, and sessions in each status. */
const insertRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels, credential_hash, created_at, updated_at)
             VALUES (${buildTestId("runner")}, 'one', 'online', 'active', 0, '[]', 'hash', ${at(0)}, ${at(0)})`;
  yield* sql`INSERT INTO projects (id, name, created_at, updated_at)
             VALUES (${buildTestId("p1")}, 'Storefront', ${at(0)}, ${at(0)}),
                    (${buildTestId("p2")}, 'Support', ${at(0)}, ${at(0)})`;
  for (const task of TASKS) {
    yield* sql`INSERT INTO tasks (id, title, description, status, stage, priority, labels, project_id,
                                  created_at, updated_at, status_changed_at, stage_changed_at, deleted_at)
               VALUES (${buildTestId(task.name)}, ${task.name}, '', ${task.status}, ${task.stage}, 'normal', '[]',
                       ${task.project === undefined ? null : buildTestId(task.project)},
                       ${at(task.minute)}, ${at(task.minute)}, ${at(task.minute)}, ${at(task.minute)},
                       ${task.deleted === true ? at(50) : null})`;
  }
  for (const run of RUNS) {
    yield* sql`INSERT INTO runs (id, plan, inputs, origin, status, failure_reason, created_at, finished_at, task_id)
               VALUES (${buildTestId(run.name)}, '{}', '{}', '{}', ${run.status},
                       ${run.status === "failed" ? "step-failed" : null}, ${at(run.minute)}, ${at(run.minute)},
                       ${buildTestId(run.task)})`;
  }
  for (const session of SESSIONS) {
    yield* sql`INSERT INTO sessions (id, permission_profile_id, provider_account_id, runner_id,
                                     requested_access_mode, access_mode, spec, title, status,
                                     created_at, last_activity_at)
               VALUES (${buildTestId(session.name)}, ${buildTestId("profile")}, ${buildTestId("provider")},
                       ${buildTestId("runner")}, 'default', 'default', '{}', ${session.name}, ${session.status},
                       ${at(0)}, ${at(session.minute)})`;
  }
});

const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations(BEFORE);
  yield* insertRows;
  yield* runMigrations(UP_TO_BOARD_RANK);
  const tasks = yield* sql<{
    readonly id: Uint8Array;
    readonly project_id: Uint8Array | null;
    readonly stage: string;
    readonly created_at: string;
    readonly board_rank: string;
    readonly failed_run_id: Uint8Array | null;
    readonly failure_revision: number;
  }>`SELECT id, project_id, stage, created_at, board_rank, failed_run_id, failure_revision FROM tasks`;
  const sessions = yield* sql<{
    readonly id: Uint8Array;
    readonly last_turn_ended_at: string | null;
  }>`SELECT id, last_turn_ended_at FROM sessions`;
  const recoveries = yield* sql`SELECT * FROM task_failure_recoveries`;
  return { tasks, sessions, recoveries };
});

describe("the task board rank migration", () => {
  it("gives every Task a rank, oldest first inside its cell, whatever the order of the ids", async () => {
    const { tasks } = await Effect.runPromise(
      migrate.pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    const cells = new Map<string, Array<{ name: string; created: string; rank: string }>>();
    for (const task of tasks) {
      expect(task.board_rank, decodeName(task.id)).not.toBe("");
      expect(task.board_rank.endsWith("0")).toBe(false);
      expect([...task.board_rank].every((c) => BOARD_RANK_ALPHABET.includes(c))).toBe(true);
      const key = `${task.project_id === null ? "none" : decodeName(task.project_id)}/${task.stage}`;
      const cell = cells.get(key) ?? [];
      cell.push({ name: decodeName(task.id), created: task.created_at, rank: task.board_rank });
      cells.set(key, cell);
    }

    const namesInRankOrder = (key: string) =>
      cells
        .get(key)!
        .toSorted((a, b) => (a.rank < b.rank ? -1 : 1))
        .map((entry) => entry.name);
    // A deleted Task keeps a place in the cell's order too.
    expect(namesInRankOrder("p1/planned")).toEqual([
      "c-oldest",
      "d-middle",
      "b-deleted",
      "a-newest",
    ]);
    expect(namesInRankOrder("none/planned")).toEqual([
      "g-no-project-1",
      "f-no-project-2",
      "k-failed-deleted",
    ]);
    expect(namesInRankOrder("p2/building")).toEqual(["h-failed-last", "i-failed-then-ok"]);
    for (const cell of cells.values()) {
      expect(new Set(cell.map((entry) => entry.rank)).size).toBe(cell.length);
    }
  });

  it("leaves room to put a card between any two migrated cards and at both ends of a cell", async () => {
    const { tasks } = await Effect.runPromise(
      migrate.pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    const ranks = tasks
      .filter(
        (task) =>
          task.project_id !== null &&
          decodeName(task.project_id) === "p1" &&
          task.stage === "planned",
      )
      .map((task) => task.board_rank)
      .toSorted();
    for (let index = 0; index <= ranks.length; index++) {
      const rank = chooseRankBetween(ranks[index - 1], ranks[index]);
      expect(rank).toBeDefined();
      if (ranks[index - 1] !== undefined) expect(rank! > ranks[index - 1]!).toBe(true);
      if (ranks[index] !== undefined) expect(rank! < ranks[index]!).toBe(true);
    }
  });

  it("shows the failure of a live Task whose newest run failed, and no other", async () => {
    const { tasks, recoveries } = await Effect.runPromise(
      migrate.pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    const failures = Object.fromEntries(
      tasks.map((task) => [
        decodeName(task.id),
        task.failed_run_id === null ? null : decodeName(task.failed_run_id),
      ]),
    );
    expect(failures["h-failed-last"]).toBe("run-h-failed");
    expect(failures["i-failed-then-ok"]).toBeNull();
    expect(failures["j-never-ran"]).toBeNull();
    expect(failures["k-failed-deleted"]).toBeNull();
    expect(failures["a-newest"]).toBeNull();
    expect(tasks.every((task) => task.failure_revision === 0)).toBe(true);
    expect(recoveries).toEqual([]);
  });

  it("gives a session that is not live the end of its last turn from its last activity", async () => {
    const { sessions } = await Effect.runPromise(
      migrate.pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(
      Object.fromEntries(sessions.map((s) => [decodeName(s.id), s.last_turn_ended_at])),
    ).toEqual({
      idle: at(30),
      exited: at(31),
      busy: null,
      queued: null,
    });
  });
});

/** Returns the steps of the query plan SQLite makes for the repository's read of one cell. */
const explainCellRead = (projectId: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tasks = yield* taskRepository;
    const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
    yield* tasks.listCellRanks({ projectId, stage: "planned" }).pipe(
      Effect.provideService(Statement.CurrentTransformer, (statement) =>
        Effect.sync(() => {
          statements.push(statement.compile());
          return statement;
        }),
      ),
    );
    const [text, params] = statements[0]!;
    const rows = yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${text}`,
      params,
    );
    return rows.map((row) => row.detail);
  });

describe("the query plan of a cell of the board", () => {
  it("reads the cards of one cell in rank order from tasks_board_rank, with no sort of its own, for a project and for none", async () => {
    const plans = await Effect.runPromise(
      Effect.gen(function* () {
        return [
          yield* explainCellRead("0199e0e7-0001-7000-8000-000000000001"),
          yield* explainCellRead(null),
        ];
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(plans).toEqual([
      ["SEARCH tasks USING INDEX tasks_board_rank (project_id=? AND stage=?)"],
      ["SEARCH tasks USING INDEX tasks_board_rank (project_id=? AND stage=?)"],
    ]);
  });
});

describe("the size of the board rank index", () => {
  it("holds the live Tasks at the five board stages and leaves out finished and deleted ones", async () => {
    const counts = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* taskRepository;
        const base = {
          description: "",
          priority: "normal",
          labels: [],
          projectId: undefined,
          provenance: [],
          at: "2026-10-20T10:00:00.000Z",
          actor: "user",
        } as const;
        for (const [title, stage, status] of [
          ["exploring", "exploring", "open"],
          ["building", "building", "in-progress"],
          ["done", "done", "done"],
          ["dropped", "dropped", "cancelled"],
        ] as const) {
          yield* tasks.insert({ ...base, title, stage, status });
        }
        const removed = yield* tasks.insert({
          ...base,
          title: "removed",
          stage: "planned",
          status: "open",
        });
        yield* tasks.softDelete(removed.id, base.at);
        return yield* sql<{ readonly stage: string }>`
          SELECT stage FROM tasks INDEXED BY tasks_board_rank
          WHERE stage NOT IN ('done', 'dropped') AND deleted_at IS NULL AND merged_into_id IS NULL`;
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(counts.map((row) => row.stage).toSorted()).toEqual(["building", "exploring"]);
  });
});
