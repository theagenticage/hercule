/**
 * Adds `sessions.process_started_at`: when the session's current process was
 * started and got its credentials. Dispatch writes it every time it starts a
 * session, so a resume writes it again. `started_at` cannot serve, because a
 * resumed session keeps its first start time.
 *
 * Account Usage needs it to drop a usage report from a process that was
 * started with a Provider Account's old key or token (spec 06 section 18.3).
 *
 * The column starts out NULL for existing sessions, which reads as "started
 * before any credential was replaced". No row is rewritten.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE sessions ADD COLUMN process_started_at TEXT`;
});
