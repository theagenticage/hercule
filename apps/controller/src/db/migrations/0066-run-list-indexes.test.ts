/**
 * Tests that the indexes the run-list-indexes migration adds serve the run list:
 *
 * - filtered with `activeSince`, the runs live at some moment of one day are
 *   found with two index lookups on `finished_at`, never with a walk of
 *   `runs_workflow` or of the whole table;
 * - filtered with `status`, the runs are read from `runs_status` in the
 *   list's order, as are the unfinished runs the run engine resumes.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Fragment } from "effect/unstable/sql/Statement";
import { TestDatabase } from "../testing";

const DAY_START = "2026-10-09T00:00:00.000Z";
const DAY_END = "2026-10-09T23:59:59.999Z";

/**
 * Returns the query plan SQLite chooses for the statement the run list sends
 * for the first page of `{ activeSince, until }`, newest first. The clauses
 * `scope` returns are added to both lookups and to the outer filter, as the
 * run list adds its `workflowId` clause.
 */
const explainDayRead = (scope: (sql: SqlClient.SqlClient) => ReadonlyArray<Fragment>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const workflowClauses = scope(sql);
      const rows = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT id, workflow_id, json_extract(plan, '$.name') AS workflow_name, origin, status,
               failure_reason, failed_step_id, failure_message, created_at, started_at,
               finished_at,
               CASE WHEN status = 'running' THEN json_extract(plan, '$.triggers') END AS triggers
        FROM (SELECT id AS active_id FROM runs
              WHERE ${sql.and([...workflowClauses, sql`finished_at IS NULL`])}
              UNION ALL
              SELECT id FROM runs
              WHERE ${sql.and([...workflowClauses, sql`finished_at >= ${DAY_START}`])})
             CROSS JOIN runs ON id = active_id
        WHERE ${sql.and([sql`1 = 1`, ...workflowClauses, sql`created_at <= ${DAY_END}`])}
        ORDER BY created_at DESC, id DESC
        LIMIT 51`;
      return rows.map((row) => row.detail).join(" / ");
    }).pipe(Effect.provide(TestDatabase), Effect.orDie),
  );

/** Returns the query plan SQLite chooses for the statement `build` returns. */
const explainStatement = (build: (sql: SqlClient.SqlClient) => Fragment) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN ${build(sql)}`;
      return rows.map((row) => row.detail).join(" / ");
    }).pipe(Effect.provide(TestDatabase), Effect.orDie),
  );

describe("the run-list-indexes migration", () => {
  it("serves one workflow's runs live during a day from runs_workflow_finished", async () => {
    const plan = await explainDayRead((sql) => [sql`workflow_id = ${new Uint8Array(16)}`]);

    expect(plan).toContain("runs_workflow_finished (workflow_id=? AND finished_at=?)");
    expect(plan).toContain("runs_workflow_finished (workflow_id=? AND finished_at>?)");
    expect(plan).not.toMatch(/runs_workflow\b(?!_finished)/);
  });

  it("serves the runs of every workflow live during a day from runs_finished", async () => {
    const plan = await explainDayRead(() => []);

    expect(plan).toContain("runs_finished (finished_at=?)");
    expect(plan).toContain("runs_finished (finished_at>?)");
    expect(plan).not.toContain("SCAN runs");
  });

  it("serves the runs of one status, newest first, from runs_status", async () => {
    const plan = await explainStatement(
      (sql) => sql`
        SELECT id FROM runs WHERE ${sql.and([sql`1 = 1`, sql`status = ${"running"}`])}
        ORDER BY created_at DESC, id DESC
        LIMIT 51`,
    );

    expect(plan).toContain("runs_status (status=?)");
    expect(plan).not.toContain("TEMP B-TREE");
  });

  it("serves the unfinished runs from runs_status", async () => {
    const plan = await explainStatement(
      (sql) => sql`
        SELECT id FROM runs WHERE status IN ('pending', 'running') ORDER BY created_at, id`,
    );

    expect(plan).toContain("runs_status (status=?)");
    expect(plan).not.toContain("SCAN runs");
  });
});
