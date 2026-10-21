/**
 * Adds a partial index on `run_steps (run_id, started_at, session_id)` for the
 * records that have a session.
 *
 * It serves the read of a run's last session, which the Tracking pane makes
 * for each of a Task's newest runs: the session of the run's step record that
 * started last. The read is one probe of the index per run, backwards from
 * the end of the run's range, so it reads one entry and needs no sort.
 *
 * `session_id` is in the index so the read never opens the step record. The
 * column was added after `output`, so a record's `session_id` sits behind
 * its output, and reading it from the table walks past a large output.
 *
 * The index is partial because only agent steps have a session. It adds no
 * column and changes no row.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX run_steps_session ON run_steps (run_id, started_at, session_id)
    WHERE session_id IS NOT NULL
  `;
});
