/**
 * Adds the two columns that link a handed-off signal to its Task.
 *
 * - `task_provenance.signal_id`: the signal a provenance entry records the
 *   handoff of. NULL for every other entry.
 * - `runs.task_id`: the Task a run works on. NULL for every run that was not
 *   started by a handoff. Like `original_run_id`, it is not a foreign key: a
 *   run row is history, and keeps the id of a Task that was deleted since.
 *
 * Both are new and optional, so no existing row changes.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE task_provenance ADD COLUMN signal_id BLOB`;
  yield* sql`ALTER TABLE runs ADD COLUMN task_id BLOB`;

  // Serves the `handedOff` filter of `task.query`, which looks for the tasks
  // that have a provenance entry with a signal. The index is partial because
  // most entries name no signal. It also holds `task_id`, so the filter's
  // subquery is answered from the index alone.
  yield* sql`
    CREATE INDEX task_provenance_signal ON task_provenance (signal_id, task_id)
    WHERE signal_id IS NOT NULL
  `;

  // Serves the run list filtered to the runs of some Tasks. The index is
  // partial because most runs work on no Task.
  yield* sql`
    CREATE INDEX runs_task_id ON runs (task_id, created_at, id) WHERE task_id IS NOT NULL
  `;
});
