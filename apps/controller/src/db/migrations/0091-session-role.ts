/**
 * Adds `sessions.role`: the session's one- or two-word name for its job, such
 * as "review" or "migration".
 *
 * The column is `NULL` for a session that has no role. That is every session
 * that exists now, and later every session that was spawned without one and
 * whose title generation did not give one. The migration fills no row.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE sessions ADD COLUMN role TEXT`;
});
