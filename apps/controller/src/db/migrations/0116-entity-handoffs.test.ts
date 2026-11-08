/**
 * Tests what the entity handoffs migration does to a database at the previous
 * head: existing Tasks start at stage and join revision 0, a handoff record
 * keeps one row per run, its first Undo answer must be JSON, and a Task's join
 * revision rises when a run or a session gets the Task or is moved onto it.
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
                                    join_revision, undo_result)
        VALUES (${buildTestId(run)}, 'github:pr:acme/api#1', ${buildTestId("task")}, 1, 1, 0, ${undoResult})`,
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

  it("raises a Task's join revision when a run or a session gets the Task or moves onto it, and for nothing else", async () => {
    const revisions = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_ENTITY_HANDOFFS);
        for (const name of ["first", "second"]) {
          yield* sql`INSERT INTO tasks (id, title, description, status, stage, priority, labels, board_rank,
                                        created_at, updated_at, status_changed_at, stage_changed_at)
                     VALUES (${buildTestId(name)}, ${name}, '', 'open', 'planned', 'normal', '[]', 'M',
                             ${AT}, ${AT}, ${AT}, ${AT})`;
        }
        const first = buildTestId("first");
        const second = buildTestId("second");
        const readRevisions = Effect.map(
          sql<{ readonly title: string; readonly join_revision: number }>`
            SELECT title, join_revision FROM tasks ORDER BY title`,
          (rows) => rows.map((row) => row.join_revision),
        );
        const steps: Array<ReadonlyArray<number>> = [];
        const runId = buildTestId("run");
        yield* sql`INSERT INTO runs (id, plan, inputs, origin, status, created_at, task_id)
                   VALUES (${runId}, '{}', '{}', '{"kind":"manual","actor":"user"}', 'pending', ${AT}, ${first})`;
        steps.push(yield* readRevisions);
        yield* sql`INSERT INTO runs (id, plan, inputs, origin, status, created_at)
                   VALUES (${buildTestId("loose")}, '{}', '{}', '{"kind":"manual","actor":"user"}', 'pending', ${AT})`;
        yield* sql`UPDATE runs SET status = 'running', started_at = ${AT} WHERE id = ${runId}`;
        steps.push(yield* readRevisions);
        yield* sql`UPDATE runs SET task_id = ${second} WHERE id = ${runId}`;
        steps.push(yield* readRevisions);
        const runnerId = buildTestId("runner");
        yield* sql`INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels, credential_hash, created_at, updated_at)
                   VALUES (${runnerId}, 'one', 'online', 'active', 0, '[]', 'hash', ${AT}, ${AT})`;
        const sessionId = buildTestId("session");
        yield* sql`INSERT INTO sessions (id, permission_profile_id, provider_account_id, runner_id,
                                         requested_access_mode, access_mode, spec, title, status,
                                         created_at, last_activity_at, task_id)
                   VALUES (${sessionId}, ${buildTestId("profile")}, ${buildTestId("account")}, ${runnerId},
                           'default', 'default', '{}', 'thread', 'idle', ${AT}, ${AT}, ${first})`;
        steps.push(yield* readRevisions);
        yield* sql`UPDATE sessions SET title = 'renamed' WHERE id = ${sessionId}`;
        steps.push(yield* readRevisions);
        yield* sql`UPDATE sessions SET task_id = ${second} WHERE id = ${sessionId}`;
        steps.push(yield* readRevisions);
        return steps;
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    // Each entry lists [first, second]. Only the Task a row points at is raised.
    expect(revisions).toEqual([
      [1, 0], // a run started on the first Task
      [1, 0], // a run with no Task, and a status change
      [1, 1], // the run moved onto the second Task
      [2, 1], // a Thread started on the first Task
      [2, 1], // a rename
      [2, 2], // the Thread moved onto the second Task
    ]);
  });
});
