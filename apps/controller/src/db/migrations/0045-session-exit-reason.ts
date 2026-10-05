/**
 * Adds `sessions.exit_reason`: why the session last exited, written by the
 * cleanup that every move to `exited` goes through. It is the runner's exit
 * reason when a runner reported the exit, or the controller's own reason when
 * the controller ended the session, such as `runner_restart`.
 *
 * The reason decides whether an agent step's session keeps its waiting step
 * prompt through the exit. That decision is also needed later, when the
 * runner refuses a prompt that was already sent before the exit, so the
 * reason is stored on the row rather than passed along once.
 *
 * The column is NULL for a session that has never exited, and for every
 * session that exited before this migration: their reason was not stored, so
 * nothing keeps a prompt for them.
 *
 * There is no CHECK on the values. The runner's exit reasons belong to the
 * protocol, and a new one must not need a migration.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE sessions ADD COLUMN exit_reason TEXT`;
});
