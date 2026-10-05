/**
 * Adds the columns agent steps and signal triggers need:
 *
 * - `sessions.run_id` and `sessions.step_id`: the run and the step in its
 *   plan whose agent step started the session. Both are NULL for every other
 *   session, and both are set together.
 * - `session_inputs.step_iteration`: the iteration of the agent step a queued
 *   input runs. It is NULL for an input that runs no step, such as a user's
 *   message to the session between two steps.
 * - `run_steps.session_id`: the session an agent step's record runs its turn
 *   in. It is NULL for every other step.
 * - `run_steps.event_id`: the event that fired a signal trigger and so
 *   started this step record. It is NULL for a record no signal started.
 *
 * None of them is a foreign key, for the same reasons as the other ids in
 * `sessions` and `runs`: a run row and a session row are history, and keep the
 * ids they were written with after what they point at is deleted.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE sessions ADD COLUMN run_id BLOB`;
  yield* sql`ALTER TABLE sessions ADD COLUMN step_id TEXT`;
  // Serves the session list filtered to one run's sessions, in the list's
  // order. The index is partial because most sessions belong to no run.
  yield* sql`
    CREATE INDEX sessions_run ON sessions (run_id, created_at, id)
    WHERE run_id IS NOT NULL
  `;

  yield* sql`ALTER TABLE session_inputs ADD COLUMN step_iteration INTEGER`;

  yield* sql`ALTER TABLE run_steps ADD COLUMN session_id BLOB`;
  yield* sql`ALTER TABLE run_steps ADD COLUMN event_id INTEGER`;
  // One event fires a step's signal trigger at most once. The engine can be
  // handed the same event again, for example when an event is routed again
  // after it was enriched, and this index makes the second step record fail
  // to insert instead of running the step twice.
  yield* sql`
    CREATE UNIQUE INDEX run_steps_signal_event ON run_steps (run_id, step_id, event_id)
    WHERE event_id IS NOT NULL
  `;
});
