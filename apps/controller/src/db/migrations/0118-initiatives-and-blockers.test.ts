/**
 * Tests what the initiatives and blockers migration does to a database at the
 * previous head: existing Tasks start on no Initiative, a Task cannot wait on
 * itself or twice on the same Task, and the reads the services make use the
 * indexes it creates.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../migrate";
import { TestDatabaseWriter } from "../testing";
import { migrations } from "./index";

const BEFORE = migrations.filter(([id]) => id < 118);
const UP_TO_INITIATIVES = migrations.filter(([id]) => id <= 118);

/** Builds the 16 bytes of a test id. */
const buildTestId = (name: string): Uint8Array => {
  const bytes = new Uint8Array(16);
  new TextEncoder().encodeInto(name, bytes);
  return bytes;
};

const AT = "2026-11-01T00:00:00.000Z";

const insertTask = (sql: SqlClient.SqlClient, name: string) =>
  sql`INSERT INTO tasks (id, title, description, status, stage, priority, labels, board_rank,
                         created_at, updated_at, status_changed_at, stage_changed_at)
      VALUES (${buildTestId(name)}, ${name}, '', 'open', 'planned', 'normal', '[]', 'M',
              ${AT}, ${AT}, ${AT}, ${AT})`;

const insertBlocker = (sql: SqlClient.SqlClient, task: string, blockedBy: string) =>
  Effect.exit(
    sql`INSERT INTO task_blockers (task_id, blocked_by_task_id, created_at, created_by)
        VALUES (${buildTestId(task)}, ${buildTestId(blockedBy)}, ${AT}, 'user')`,
  );

const explain = (sql: SqlClient.SqlClient, statement: string) =>
  sql
    .unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${statement}`)
    .pipe(Effect.map((rows) => rows.map((row) => row.detail).join("\n")));

describe("the initiatives and blockers migration", () => {
  it("starts every existing Task on no Initiative", async () => {
    const tasks = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* insertTask(sql, "task");
        yield* runMigrations(UP_TO_INITIATIVES);
        return yield* sql<{ readonly initiative_id: Uint8Array | null }>`
          SELECT initiative_id FROM tasks`;
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(tasks).toEqual([{ initiative_id: null }]);
  });

  it("refuses a Task that waits on itself and a repeated pair, and takes either direction once", async () => {
    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_INITIATIVES);
        yield* insertTask(sql, "first");
        yield* insertTask(sql, "second");
        return [
          (yield* insertBlocker(sql, "first", "first"))._tag,
          (yield* insertBlocker(sql, "first", "second"))._tag,
          (yield* insertBlocker(sql, "first", "second"))._tag,
          (yield* insertBlocker(sql, "second", "first"))._tag,
        ];
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(outcomes).toEqual(["Failure", "Success", "Failure", "Success"]);
  });

  it("reads what a Task blocks, the open Initiatives and the closed ones through indexes", async () => {
    const plans = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_INITIATIVES);
        return {
          blocks: yield* explain(
            sql,
            "SELECT task_id FROM task_blockers WHERE blocked_by_task_id = x'00'",
          ),
          open: yield* explain(
            sql,
            `SELECT id FROM initiatives
             WHERE deleted_at IS NULL AND closed_at IS NULL ORDER BY created_at, id`,
          ),
          closed: yield* explain(
            sql,
            `SELECT id FROM initiatives
             WHERE deleted_at IS NULL AND closed_at IS NOT NULL ORDER BY created_at, id`,
          ),
          members: yield* explain(
            sql,
            `SELECT id FROM tasks
             WHERE initiative_id = x'00' AND deleted_at IS NULL AND initiative_id IS NOT NULL`,
          ),
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(plans.blocks).toMatch(/USING (COVERING )?INDEX task_blockers_blocked_by/);
    expect(plans.open).toMatch(/INDEX initiatives_open/);
    expect(plans.open).not.toContain("TEMP B-TREE");
    expect(plans.closed).toMatch(/INDEX initiatives_closed/);
    expect(plans.closed).not.toContain("TEMP B-TREE");
    expect(plans.members).toMatch(/INDEX tasks_initiative/);
  });
});
