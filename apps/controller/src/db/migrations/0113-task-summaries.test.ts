/**
 * Tests what the task summaries migration does to a database at the previous
 * head: it adds the summary table and the two partial indexes, makes the board
 * index again without merged Tasks, leaves every existing Task unmerged, marks
 * nothing dirty, and leaves every existing recovery without an Undo answer.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../migrate";
import { TestDatabaseWriter } from "../testing";
import { migrations } from "./index";

const BEFORE = migrations.filter(([id]) => id < 113);
const UP_TO_TASK_SUMMARIES = migrations.filter(([id]) => id <= 113);

/** Builds the 16 bytes of a test id. */
const buildTestId = (name: string): Uint8Array => {
  const bytes = new Uint8Array(16);
  new TextEncoder().encodeInto(name, bytes);
  return bytes;
};

const AT = "2026-11-01T00:00:00.000Z";

const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations(BEFORE);
  yield* sql`INSERT INTO tasks (id, title, description, status, stage, priority, labels, board_rank,
                                created_at, updated_at, status_changed_at, stage_changed_at)
             VALUES (${buildTestId("task")}, 'Gift cards', '', 'open', 'planned', 'normal', '[]', 'M',
                     ${AT}, ${AT}, ${AT}, ${AT})`;
  yield* sql`INSERT INTO task_provenance (id, task_id, ref, at, actor)
             VALUES (${buildTestId("entry")}, ${buildTestId("task")}, 'github:acme/shop#1', ${AT}, 'user')`;
  yield* sql`INSERT INTO task_failure_recoveries (run_id, task_id, failed_run_id, revision_after)
             VALUES (${buildTestId("retry")}, ${buildTestId("task")}, ${buildTestId("failed")}, 1)`;
  yield* runMigrations(UP_TO_TASK_SUMMARIES);
  const tasks = yield* sql<{ readonly merged_into_id: Uint8Array | null }>`
    SELECT merged_into_id FROM tasks`;
  const summaries = yield* sql`SELECT * FROM task_summaries`;
  const provenance = yield* sql<{ readonly merged_task_id: Uint8Array | null }>`
    SELECT merged_task_id FROM task_provenance`;
  const recoveries = yield* sql<{
    readonly undo_outcome: string | null;
    readonly undo_stop_requested: number | null;
    readonly undo_reason: string | null;
  }>`SELECT undo_outcome, undo_stop_requested, undo_reason FROM task_failure_recoveries`;
  const indexes = yield* sql<{ readonly name: string; readonly sql: string }>`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'index'
      AND name IN ('task_summaries_dirty', 'tasks_merged_into', 'tasks_board_rank')`;
  return { tasks, summaries, provenance, recoveries, indexes };
});

describe("the task summaries migration", () => {
  it("leaves existing Tasks unmerged, writes no summary, marks no provenance entry as a merge, and leaves recoveries without an Undo answer", async () => {
    const { tasks, summaries, provenance, recoveries } = await Effect.runPromise(
      migrate.pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(tasks).toEqual([{ merged_into_id: null }]);
    expect(summaries).toEqual([]);
    expect(provenance).toEqual([{ merged_task_id: null }]);
    expect(recoveries).toEqual([
      { undo_outcome: null, undo_stop_requested: null, undo_reason: null },
    ]);
  });

  it("indexes only the Tasks that wait for a summary and the Tasks that were merged, and keeps the merged Tasks out of the board index", async () => {
    const { indexes } = await Effect.runPromise(
      migrate.pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    const conditions = Object.fromEntries(
      indexes.map((index) => [index.name, index.sql.slice(index.sql.indexOf("WHERE")).trim()]),
    );
    expect(conditions).toEqual({
      task_summaries_dirty: "WHERE dirty_at IS NOT NULL",
      tasks_merged_into: "WHERE deleted_at IS NULL AND merged_into_id IS NOT NULL",
      tasks_board_rank:
        "WHERE deleted_at IS NULL AND merged_into_id IS NULL AND stage NOT IN ('done', 'dropped')",
    });
  });
});
