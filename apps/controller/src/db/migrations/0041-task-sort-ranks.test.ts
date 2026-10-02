/**
 * Tests that the two rank indexes of migration 0041 serve a sort on priority
 * and a sort on status, in both directions, without a temporary b-tree, and
 * that a later page starts with one seek to the row after the cursor rather
 * than reading the rows before it.
 *
 * The query is the one the task repository writes: its sort columns are read
 * from the repository's own table, and its `ORDER BY` and boundary are built by
 * the same `buildKeyset`.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SortDirection } from "@hercule/contract";
import { TASK_SORT_COLUMNS } from "../../tasks/repository";
import { uuidFromString } from "../id";
import { buildKeyset } from "../page";
import { TestDatabase } from "../testing";

/**
 * Returns SQLite's query plan for a page of a task listing sorted by one
 * field, with the plan's steps joined by " / ". `after` holds the rank and the
 * id of the previous page's last row, and is `undefined` for the first page.
 */
const explainTaskSort = (
  field: "priority" | "status",
  direction: SortDirection,
  after: readonly [number, string] | undefined,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { keyset, order } = buildKeyset(
        sql,
        [{ column: TASK_SORT_COLUMNS[field].column, direction }],
        ["tasks.id"],
        after === undefined ? undefined : [after[0], uuidFromString(after[1])],
      );
      const rows = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT tasks.id FROM tasks WHERE tasks.deleted_at IS NULL AND ${keyset} ${order} LIMIT 51
      `;
      return rows.map((row) => row.detail).join(" / ");
    }).pipe(Effect.provide(TestDatabase)),
  );

const ID = "0192ce07-8c4f-7d66-afec-2482b5c9b03c";

const CASES = [
  ["priority", "asc", "tasks_priority", "(priority_rank,id)>(?,?)"],
  ["priority", "desc", "tasks_priority", "(priority_rank,id)<(?,?)"],
  ["status", "asc", "tasks_status", "(status_rank,id)>(?,?)"],
  ["status", "desc", "tasks_status", "(status_rank,id)<(?,?)"],
] as const;

describe("the task sort ranks", () => {
  // `tasks_status` is a prefix of `tasks_status_updated_at`, so each test also
  // checks that the plan names no longer index.
  it.each(CASES)(
    "serve the first page of a %s %s sort from %s, without a temporary b-tree",
    async (field, direction, index) => {
      const plan = await explainTaskSort(field, direction, undefined);
      expect(plan).toContain(`INDEX ${index}`);
      expect(plan).not.toContain(`${index}_`);
      // A temporary b-tree sorts the whole matching set for every page, so page
      // one hundred would cost as much as page one.
      expect(plan).not.toContain("TEMP B-TREE");
    },
  );

  it.each(CASES)(
    "start a later page of a %s %s sort with a seek into %s on %s",
    async (field, direction, index, seek) => {
      const plan = await explainTaskSort(field, direction, [1, ID]);
      // The seek must use the rank and the id together. A seek on the rank
      // alone, or a `SCAN`, reads every row before the cursor, so each page
      // would cost more than the one before it.
      expect(plan).toContain(`SEARCH tasks USING INDEX ${index} (${seek})`);
      expect(plan).not.toContain(`${index}_`);
      expect(plan).not.toContain("TEMP B-TREE");
    },
  );
});
