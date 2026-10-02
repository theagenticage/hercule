/**
 * Adds a rank column for a task's priority and for its status, and rebuilds
 * the two task indexes that serve a sort on them, so each sorts by the rank
 * rather than by the stored word.
 *
 * - Priority ascends low, normal, high, urgent. The index from migration 0003
 *   ranks urgent 0 to low 3, the reverse.
 * - Status ascends open, in-progress, done, cancelled: the order work moves
 *   through them. The index from migration 0003 holds the word itself, which
 *   sorts alphabetically.
 *
 * Each rank is a virtual generated column: SQLite computes it from the word
 * when a row is read, and the index holds it. It is a column rather than an
 * index on the `CASE` expression because SQLite resumes a later page with
 * one index seek, `(rank, id) > (?, ?)`, only on plain columns. On an
 * expression index it reads every row before the cursor instead, so each
 * page would cost more than the one before it.
 *
 * Dropping the old `tasks_status (status, id)` costs the status filter
 * nothing: `tasks_status_updated_at (status, updated_at, id)` serves the
 * filter, as migration 0003 explains.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE tasks ADD COLUMN priority_rank INTEGER NOT NULL GENERATED ALWAYS AS (
      CASE priority WHEN 'low' THEN 0 WHEN 'normal' THEN 1 WHEN 'high' THEN 2 ELSE 3 END
    ) VIRTUAL
  `;
  yield* sql`DROP INDEX tasks_priority`;
  yield* sql`CREATE INDEX tasks_priority ON tasks (priority_rank, id) WHERE deleted_at IS NULL`;

  yield* sql`
    ALTER TABLE tasks ADD COLUMN status_rank INTEGER NOT NULL GENERATED ALWAYS AS (
      CASE status WHEN 'open' THEN 0 WHEN 'in-progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END
    ) VIRTUAL
  `;
  yield* sql`DROP INDEX tasks_status`;
  yield* sql`CREATE INDEX tasks_status ON tasks (status_rank, id) WHERE deleted_at IS NULL`;
});
