/**
 * Tests what the stage facts migration does to a database at the previous
 * head: existing Tasks start with no fence and no cause, a fact keeps the
 * lifecycles the contract allows and takes its ids in order, a Task has one
 * suppression per ref, a shipped key is installed once, and a lookup of one
 * Task's facts for one ref uses the index, and so does a lookup of the entities
 * whose head is one branch.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../migrate";
import { TestDatabaseWriter } from "../testing";
import { migrations } from "./index";

const BEFORE = migrations.filter(([id]) => id < 117);
const UP_TO_STAGE_FACTS = migrations.filter(([id]) => id <= 117);

/** Builds the 16 bytes of a test id. */
const buildTestId = (name: string): Uint8Array => {
  const bytes = new Uint8Array(16);
  new TextEncoder().encodeInto(name, bytes);
  return bytes;
};

const AT = "2026-11-01T00:00:00.000Z";
const REF = "github:pull-request:acme/api#1";

const insertTask = (sql: SqlClient.SqlClient, name: string) =>
  sql`INSERT INTO tasks (id, title, description, status, stage, priority, labels, board_rank,
                         created_at, updated_at, status_changed_at, stage_changed_at)
      VALUES (${buildTestId(name)}, ${name}, '', 'open', 'planned', 'normal', '[]', 'M',
              ${AT}, ${AT}, ${AT}, ${AT})`;

const insertFact = (
  sql: SqlClient.SqlClient,
  task: string,
  lifecycle: string,
  previousLifecycle: string | null,
) =>
  Effect.exit(
    sql`INSERT INTO task_entity_facts (task_id, ref, lifecycle, previous_lifecycle, observed_at)
        VALUES (${buildTestId(task)}, ${REF}, ${lifecycle}, ${previousLifecycle}, ${AT})`,
  );

describe("the stage facts migration", () => {
  it("starts every existing Task with a fence of 0 and no cause", async () => {
    const tasks = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* insertTask(sql, "task");
        yield* runMigrations(UP_TO_STAGE_FACTS);
        return yield* sql<{
          readonly stage_fact_fence: number;
          readonly stage_cause_fact_id: number | null;
        }>`SELECT stage_fact_fence, stage_cause_fact_id FROM tasks`;
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(tasks).toEqual([{ stage_fact_fence: 0, stage_cause_fact_id: null }]);
  });

  it("numbers facts in the order they are written and accepts only the three lifecycles", async () => {
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_STAGE_FACTS);
        yield* insertTask(sql, "task");
        const linked = yield* insertFact(sql, "task", "open", null);
        const merged = yield* insertFact(sql, "task", "completed", "open");
        const badLifecycle = yield* insertFact(sql, "task", "merged", "open");
        const badPrevious = yield* insertFact(sql, "task", "completed", "merged");
        const ids = yield* sql<{ readonly id: number; readonly voided_at: string | null }>`
          SELECT id, voided_at FROM task_entity_facts ORDER BY id`;
        return {
          outcomes: [linked, merged, badLifecycle, badPrevious].map((exit) => exit._tag),
          ids,
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(results.outcomes).toEqual(["Success", "Success", "Failure", "Failure"]);
    expect(results.ids).toEqual([
      { id: 1, voided_at: null },
      { id: 2, voided_at: null },
    ]);
  });

  it("never reuses the id of a fact that was deleted", async () => {
    const ids = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_STAGE_FACTS);
        yield* insertTask(sql, "task");
        yield* insertFact(sql, "task", "open", null);
        yield* sql`DELETE FROM task_entity_facts`;
        yield* insertFact(sql, "task", "open", null);
        return yield* sql<{ readonly id: number }>`SELECT id FROM task_entity_facts`;
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(ids).toEqual([{ id: 2 }]);
  });

  it("holds one suppression per Task and ref, one row per shipped key and one attempt per branch", async () => {
    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_STAGE_FACTS);
        yield* insertTask(sql, "task");
        const suppress = Effect.exit(
          sql`INSERT INTO task_entity_link_suppressions (task_id, ref, suppressed_at, suppressed_by)
              VALUES (${buildTestId("task")}, ${REF}, ${AT}, 'user')`,
        );
        const ship = Effect.exit(
          sql`INSERT INTO shipped_workflows (key, workflow_id, installed_at)
              VALUES ('card-landed', ${buildTestId("workflow")}, ${AT})`,
        );
        yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
                                            status, labels, config, created_at, updated_at)
                   VALUES (${buildTestId("connection")}, 'github', 'github/github', 'work', 'octocat',
                           '1', 'connected', '[]', '{}', ${AT}, ${AT})`;
        const attempt = Effect.exit(
          sql`INSERT INTO tracked_branch_attempts (connection_id, remote, branch, last_attempted_at)
              VALUES (${buildTestId("connection")}, 'github.com/acme/api', 'fix-login', ${AT})`,
        );
        return {
          suppression: [(yield* suppress)._tag, (yield* suppress)._tag],
          shipped: [(yield* ship)._tag, (yield* ship)._tag],
          attempt: [(yield* attempt)._tag, (yield* attempt)._tag],
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(outcomes).toEqual({
      suppression: ["Success", "Failure"],
      shipped: ["Success", "Failure"],
      attempt: ["Success", "Failure"],
    });
  });

  it("finds one Task's facts for one ref through the (task_id, ref, id) index", async () => {
    const plan = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_STAGE_FACTS);
        const rows = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN SELECT id FROM task_entity_facts
           WHERE task_id = x'00' AND ref = 'a' ORDER BY id`,
        );
        return rows.map((row) => row.detail).join("\n");
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(plan).toMatch(
      /SEARCH task_entity_facts USING (COVERING )?INDEX task_entity_facts_task_ref/,
    );
    expect(plan).not.toContain("TEMP B-TREE");
  });

  it("finds the entities whose head is a branch through the external_entities_head index", async () => {
    const plan = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_STAGE_FACTS);
        const rows = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN SELECT ref FROM external_entities
           WHERE json_extract(repository, '$.head.remote') = 'github.com/acme/api'
             AND json_extract(repository, '$.head.branch') = 'fix-login'`,
        );
        return rows.map((row) => row.detail).join("\n");
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(plan).toMatch(/SEARCH external_entities USING INDEX external_entities_head/);
  });
});
