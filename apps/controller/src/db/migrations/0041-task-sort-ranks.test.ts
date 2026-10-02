/**
 * Tests that the two rank indexes the task sort ranks migration builds serve
 * a sort on priority and a sort on status, in both directions, without a
 * temporary b-tree.
 *
 * The query is the one the task repository writes: its sort columns are read
 * from the repository's own table, and its `ORDER BY` is built by the same
 * `buildKeyset`. SQLite uses an expression index only for the identical
 * expression, so a repository expression that drifts from the migration's
 * index fails here rather than quietly sorting every page in memory.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SortDirection } from "@hercule/contract";
import { TASK_SORT_COLUMNS } from "../../tasks/repository";
import { buildKeyset } from "../page";
import { TestDatabase } from "../testing";

/**
 * Returns SQLite's query plan for the first page of a task listing sorted by
 * one field, with the plan's steps joined by " / ".
 */
const explainTaskSort = (field: "priority" | "status", direction: SortDirection) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { keyset, order } = buildKeyset(
        sql,
        [{ column: TASK_SORT_COLUMNS[field].column, direction }],
        ["tasks.id"],
        undefined,
      );
      const rows = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT tasks.id FROM tasks WHERE tasks.deleted_at IS NULL AND ${keyset} ${order} LIMIT 51
      `;
      return rows.map((row) => row.detail).join(" / ");
    }).pipe(Effect.provide(TestDatabase)),
  );

describe("the task sort ranks", () => {
  it.each([
    ["priority", "asc", "tasks_priority"],
    ["priority", "desc", "tasks_priority"],
    ["status", "asc", "tasks_status"],
    ["status", "desc", "tasks_status"],
  ] as const)(
    "serve a %s %s sort from %s, without a temporary b-tree",
    async (field, direction, index) => {
      const plan = await explainTaskSort(field, direction);
      expect(plan).toContain(`INDEX ${index}`);
      // A temporary b-tree sorts the whole matching set for every page, so page
      // one hundred would cost as much as page one.
      expect(plan).not.toContain("TEMP B-TREE");
    },
  );
});
