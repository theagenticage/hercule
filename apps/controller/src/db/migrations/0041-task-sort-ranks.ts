/**
 * Rebuilds the two task indexes that serve a sort on priority and on status,
 * so each sorts by a rank rather than by the stored word.
 *
 * - Priority ascends low, normal, high, urgent. The index from migration 0003
 *   ranks urgent 0 to low 3, the reverse.
 * - Status ascends open, in-progress, done, cancelled: the order work moves
 *   through them. The index from migration 0003 holds the word itself, which
 *   sorts alphabetically.
 *
 * The task repository orders by these two `CASE` expressions, written
 * character for character the same way, because SQLite uses an expression
 * index only for the identical expression.
 *
 * Dropping the old `tasks_status (status, id)` costs the status filter
 * nothing: `tasks_status_updated_at (status, updated_at, id)` serves the
 * filter, as migration 0003 explains.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX tasks_priority`;
  yield* sql`
    CREATE INDEX tasks_priority ON tasks (
      CASE priority WHEN 'low' THEN 0 WHEN 'normal' THEN 1 WHEN 'high' THEN 2 ELSE 3 END,
      id
    ) WHERE deleted_at IS NULL
  `;

  yield* sql`DROP INDEX tasks_status`;
  yield* sql`
    CREATE INDEX tasks_status ON tasks (
      CASE status WHEN 'open' THEN 0 WHEN 'in-progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
      id
    ) WHERE deleted_at IS NULL
  `;
});
