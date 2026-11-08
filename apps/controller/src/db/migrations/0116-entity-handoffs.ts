/**
 * Lets a handoff of an External Entity be taken back.
 *
 * - `entity_handoffs` has one row per handoff of a thing to a workflow, so
 *   the Undo of that handoff can tell what it did and what may be taken back.
 *   `task_created` is whether the handoff made the Task, and `stage_before` is
 *   the stage a continued Task had (null for a new one). `stage_revision` is
 *   the Task's `stage_revision` right after the handoff wrote it: an Undo
 *   restores the stage only while the Task still has that value.
 *   `undone_at` and `undo_result` (the first answer, as JSON) are set by the
 *   first Undo, and a repeat returns that answer. Like `runs.task_id`, its ids
 *   are not foreign keys: a run is history that keeps the id of a Task deleted
 *   since.
 * - `tasks.stage_revision` counts the stage decisions made on a Task. It rises
 *   on every write with an explicit stage, even of the same value, which
 *   leaves no timestamp behind. It starts at 0 for every Task.
 *
 * The migration only adds a table and a column, so the upgrade test needs no
 * fixture for it.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE entity_handoffs (
      run_id BLOB PRIMARY KEY NOT NULL,
      ref TEXT NOT NULL,
      task_id BLOB NOT NULL,
      task_created INTEGER NOT NULL CHECK (task_created IN (0, 1)),
      stage_before TEXT,
      stage_revision INTEGER NOT NULL,
      undone_at TEXT,
      undo_result TEXT CHECK (undo_result IS NULL OR json_valid(undo_result))
    ) WITHOUT ROWID
  `;

  yield* sql`ALTER TABLE tasks ADD COLUMN stage_revision INTEGER NOT NULL DEFAULT 0`;
});
