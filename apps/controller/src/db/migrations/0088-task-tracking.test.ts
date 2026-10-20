/**
 * Tests what the task tracking migration does to a database at the previous
 * head: `task_provenance` gains `signal_id` and `runs` gains `task_id`, both
 * NULL for every row written before, and the two partial indexes that serve
 * the handed-off task filter and the run filter by task exist and are the
 * ones those queries use.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabaseWriter } from "../testing";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 88);

const at = "2026-10-20T00:00:00.000Z";

describe("the task tracking migration", () => {
  it("adds signal_id and task_id as NULL to existing rows, with a partial index each that the queries use", async () => {
    const { provenance, runs, indexes, handedOffPlan, runsByTaskPlan } = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`
          INSERT INTO tasks (id, title, description, status, priority, labels, created_at, updated_at, status_changed_at)
          VALUES ('task', 'A task', '', 'open', 'normal', '[]', ${at}, ${at}, ${at})`;
        yield* sql`
          INSERT INTO task_provenance (id, task_id, ref, at, actor)
          VALUES ('entry', 'task', 'github:issue:o/r#1', ${at}, 'user')`;
        yield* sql`
          INSERT INTO runs (id, plan, inputs, origin, status, created_at)
          VALUES ('run', '{}', '{}', '{}', 'pending', ${at})`;
        yield* runMigrations();
        const provenance = yield* sql<{
          readonly id: string;
          readonly signal_id: Uint8Array | null;
        }>`SELECT CAST(id AS TEXT) AS id, signal_id FROM task_provenance`;
        const runs = yield* sql<{
          readonly id: string;
          readonly task_id: Uint8Array | null;
        }>`SELECT CAST(id AS TEXT) AS id, task_id FROM runs`;
        const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`
          SELECT name, sql FROM sqlite_master
          WHERE type = 'index' AND name IN ('task_provenance_handoff', 'runs_task_id')
          ORDER BY name`;
        // The query of the task filter for the tasks that were handed off.
        const handedOffPlan = yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT * FROM tasks
          WHERE tasks.id IN (SELECT task_id FROM task_provenance WHERE signal_id IS NOT NULL)`;
        // The query of the run list filtered to the runs of some Tasks.
        const runsByTaskPlan = yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT * FROM runs WHERE task_id IN (${new Uint8Array(16)}, ${new Uint8Array(16)})
          ORDER BY created_at DESC, id DESC`;
        return { provenance, runs, indexes, handedOffPlan, runsByTaskPlan };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(provenance).toEqual([{ id: "entry", signal_id: null }]);
    expect(runs).toEqual([{ id: "run", task_id: null }]);
    expect(indexes.map((index) => [index.name, index.sql.replace(/\s+/g, " ").trim()])).toEqual([
      [
        "runs_task_id",
        "CREATE INDEX runs_task_id ON runs (task_id, created_at, id) WHERE task_id IS NOT NULL",
      ],
      [
        "task_provenance_handoff",
        "CREATE INDEX task_provenance_handoff ON task_provenance (task_id, at) WHERE signal_id IS NOT NULL",
      ],
    ]);
    // The partial index holds only the entries that name a signal, so the
    // subquery walks those and not the whole provenance table.
    expect(handedOffPlan.map((step) => step.detail)).toContain(
      "SCAN task_provenance USING INDEX task_provenance_handoff",
    );
    // One lookup per task id, then a sort, because the rows of several tasks
    // are not in order across the ids.
    expect(runsByTaskPlan.map((step) => step.detail)).toEqual([
      "SEARCH runs USING INDEX runs_task_id (task_id=?)",
      "USE TEMP B-TREE FOR ORDER BY",
    ]);
  });
});
