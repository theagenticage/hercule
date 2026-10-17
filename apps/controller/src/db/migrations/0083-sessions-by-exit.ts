/**
 * Adds an index on `sessions (status, exited_at)`, which serves the session
 * list filtered with `activeSince`: the sessions that had not exited before
 * an instant. Those are the sessions that are not exited, and the exited
 * sessions whose `exited_at` is at or after the instant. The session list
 * finds them with two lookups on this index, one for each half of the
 * filter, so a read costs as many sessions as are live now or exited since
 * the instant, not every session the controller ever had.
 *
 * The filter cannot use `exited_at` alone: a resumed session keeps the
 * `exited_at` of its last exit while it is live again.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE INDEX sessions_status_exited ON sessions (status, exited_at)`;
});
