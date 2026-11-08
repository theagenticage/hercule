/**
 * Lets a handoff of an External Entity be taken back.
 *
 * - `entity_handoffs` has one row per handoff of a thing to a workflow, so
 *   the Undo of that handoff can tell what it did and what may be taken back.
 *   `task_created` is whether the handoff made the Task, and `stage_before` is
 *   the stage a continued Task had (null for a new one). `stage_revision` is
 *   the Task's `stage_revision` right after the handoff wrote it: an Undo
 *   restores the stage only while the Task still has that value.
 *   `join_revision` is the Task's `join_revision` right after the handoff
 *   wrote it: an Undo takes the handoff back only while nothing has joined
 *   the Task since.
 *   `undone_at` and `undo_result` (the first answer, as JSON) are set by the
 *   first Undo, and a repeat returns that answer. Like `runs.task_id`, its ids
 *   are not foreign keys: a run is history that keeps the id of a Task deleted
 *   since.
 * - `tasks.stage_revision` counts the stage decisions made on a Task. It rises
 *   on every write with an explicit stage, even of the same value, which
 *   leaves no timestamp behind. It starts at 0 for every Task.
 * - `tasks.join_revision` counts the times a run or a session got the Task or
 *   was moved onto it. Four triggers raise it, so every path that attaches
 *   work to a Task is seen without a list of those paths: a run started on
 *   the Task, a Thread started on or moved onto it, and the runs and Threads
 *   of a Task merged into it. A count of the Task's runs and sessions would
 *   miss a Thread that joins while another leaves.
 * - `tasks_failed` lists the Tasks the board shows with a failed run, so the
 *   sidebar's "does any Task have a failure" read is one index lookup on every
 *   screen and never a walk over all Tasks. Its conditions are the board's:
 *   live, not at `done` or `dropped`, and `failed_run_id` set (see
 *   `existsFailedTaskOnBoard`).
 *
 * The migration only adds a table, columns, triggers and an index, so the upgrade test
 * needs no fixture for it.
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
      join_revision INTEGER NOT NULL,
      undone_at TEXT,
      undo_result TEXT CHECK (undo_result IS NULL OR json_valid(undo_result))
    ) WITHOUT ROWID
  `;

  yield* sql`ALTER TABLE tasks ADD COLUMN stage_revision INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE tasks ADD COLUMN join_revision INTEGER NOT NULL DEFAULT 0`;

  // Each trigger raises the revision of the Task the row now points at. They
  // fire for an insert, and for an update that changes `task_id` (a Thread
  // moved, a merge moving rows), and not for other updates, such as a run's
  // status. A Task that has no row yet is not raised: the row is written
  // after its first run, with the revision at 0, which is what a handoff
  // reads and remembers.
  for (const table of ["runs", "sessions"] as const) {
    yield* sql`
      CREATE TRIGGER ${sql.literal(`${table}_join_insert`)} AFTER INSERT ON ${sql.literal(table)}
      WHEN NEW.task_id IS NOT NULL
      BEGIN
        UPDATE tasks SET join_revision = join_revision + 1 WHERE id = NEW.task_id;
      END
    `;
    yield* sql`
      CREATE TRIGGER ${sql.literal(`${table}_join_update`)} AFTER UPDATE OF task_id ON ${sql.literal(table)}
      WHEN NEW.task_id IS NOT NULL AND NEW.task_id IS NOT OLD.task_id
      BEGIN
        UPDATE tasks SET join_revision = join_revision + 1 WHERE id = NEW.task_id;
      END
    `;
  }

  // The text of the conditions is the one `existsFailedTaskOnBoard` writes:
  // SQLite uses a partial index only for a query that repeats them.
  yield* sql`
    CREATE INDEX tasks_failed ON tasks (failed_run_id)
      WHERE deleted_at IS NULL AND merged_into_id IS NULL AND failed_run_id IS NOT NULL
        AND stage NOT IN ('done', 'dropped')
  `;
});
