/**
 * Tests what the entity handoffs migration does to a database at the previous
 * head: existing Tasks start at stage revision 0, a handoff record keeps one
 * row per run, and its first Undo answer must be JSON.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../migrate";
import { TestDatabaseWriter } from "../testing";
import { migrations } from "./index";

const BEFORE = migrations.filter(([id]) => id < 116);
const UP_TO_ENTITY_HANDOFFS = migrations.filter(([id]) => id <= 116);

/** Builds the 16 bytes of a test id. */
const buildTestId = (name: string): Uint8Array => {
  const bytes = new Uint8Array(16);
  new TextEncoder().encodeInto(name, bytes);
  return bytes;
};

const AT = "2026-11-01T00:00:00.000Z";

const insertHandoff = (sql: SqlClient.SqlClient, run: string, undoResult: string | null) =>
  Effect.exit(
    sql`INSERT INTO entity_handoffs (run_id, ref, task_id, task_created, stage_revision,
                                    runs_on_task, sessions_on_task, undo_result)
        VALUES (${buildTestId(run)}, 'github:pr:acme/api#1', ${buildTestId("task")}, 1, 1, 1, 0, ${undoResult})`,
  );

describe("the entity handoffs migration", () => {
  it("starts every existing Task at stage revision 0", async () => {
    const tasks = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`INSERT INTO tasks (id, title, description, status, stage, priority, labels, board_rank,
                                      created_at, updated_at, status_changed_at, stage_changed_at)
                   VALUES (${buildTestId("task")}, 'Gift cards', '', 'open', 'planned', 'normal', '[]', 'M',
                           ${AT}, ${AT}, ${AT}, ${AT})`;
        yield* runMigrations(UP_TO_ENTITY_HANDOFFS);
        return yield* sql<{ readonly stage_revision: number }>`SELECT stage_revision FROM tasks`;
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(tasks).toEqual([{ stage_revision: 0 }]);
  });

  it("holds one handoff record per run and refuses an undo answer that is not JSON", async () => {
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_ENTITY_HANDOFFS);
        return {
          first: (yield* insertHandoff(sql, "run", null))._tag,
          repeat: (yield* insertHandoff(sql, "run", null))._tag,
          json: (yield* insertHandoff(sql, "other", '{"outcome":"undone"}'))._tag,
          notJson: (yield* insertHandoff(sql, "third", "{oops"))._tag,
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(results).toEqual({
      first: "Success",
      repeat: "Failure",
      json: "Success",
      notJson: "Failure",
    });
  });
});
