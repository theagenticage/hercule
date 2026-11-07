/**
 * Gives a Task a summary and a way to be merged into another Task (spec 09).
 *
 * - `task_summaries` holds what a cheap model wrote to describe a Task, with
 *   the bookkeeping that keeps it current. It is a table of its own, not
 *   fields on `tasks`: a write to a summary must not move `updated_at`, copy
 *   text into a `task.updated` event, or start a workflow.
 *   - `input_revision` is the `dirty_revision` the summary was made from.
 *   - `dirty_revision` rises in the transaction of every change the summary
 *     reads, and `dirty_at` is when the Task was first changed since the last
 *     summary. It is null while the summary is current.
 *   - `last_attempt_at` and `next_attempt_at` pace the model calls, so a
 *     failing Task is not tried again at once. `attempt_count` is the
 *     failures in a row.
 *   - The partial index serves the writer's read of the Tasks that wait for a
 *     summary, and holds only those, so its size follows the work waiting and
 *     not the number of Tasks.
 * - `tasks.merged_into_id` is the Task this one was merged into, or null.
 *   A merged Task is gone from every read, and a read of its id returns the
 *   survivor. Like `runs.task_id`, it is not a foreign key. The partial index
 *   serves the lookup of the Tasks merged into one Task, which a merge repoints
 *   so that a redirect is always one hop. It leaves out deleted Tasks, as every
 *   index of `tasks` does, and a merged Task is never deleted, because a delete
 *   of its id lands on the survivor. A read of it repeats the index's condition.
 * - `task_failure_recoveries` gains the answer of the first Undo of a Try
 *   again (`task.undoTryAgain`), so that a repeat of the Undo returns exactly
 *   that answer. All three columns are null until the Undo is decided.
 *
 * It marks nothing dirty: an existing Task gets its first summary when its
 * next turn ends, not in one burst at the upgrade.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE task_summaries (
      task_id BLOB PRIMARY KEY NOT NULL REFERENCES tasks (id),
      line TEXT,
      standing_text TEXT,
      left_text TEXT,
      input_revision INTEGER NOT NULL,
      generated_at TEXT,
      dirty_revision INTEGER NOT NULL,
      dirty_at TEXT,
      last_attempt_at TEXT,
      next_attempt_at TEXT,
      attempt_count INTEGER NOT NULL,
      failed_at TEXT,
      failed_reason TEXT
    )
  `;
  yield* sql`
    CREATE INDEX task_summaries_dirty ON task_summaries (dirty_at) WHERE dirty_at IS NOT NULL
  `;

  yield* sql`ALTER TABLE tasks ADD COLUMN merged_into_id BLOB`;
  yield* sql`
    CREATE INDEX tasks_merged_into ON tasks (merged_into_id)
      WHERE deleted_at IS NULL AND merged_into_id IS NOT NULL
  `;

  // The outcome is one of `restored`, `stopped` and `too-late`. A Boolean is
  // stored as 0 or 1.
  yield* sql`ALTER TABLE task_failure_recoveries ADD COLUMN undo_outcome TEXT`;
  yield* sql`ALTER TABLE task_failure_recoveries ADD COLUMN undo_stop_requested INTEGER`;
  yield* sql`ALTER TABLE task_failure_recoveries ADD COLUMN undo_reason TEXT`;
});
