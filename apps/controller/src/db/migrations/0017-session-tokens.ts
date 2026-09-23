/**
 * The hash of the session's own credential on the public API.
 *
 * A column rather than a table: checking a presented token is one indexed
 * lookup that has to read the session's permission profile anyway. A session
 * also has exactly one live token at a time: a resume replaces it, and an exit
 * ends it through the session status rather than a revocation row nobody would
 * read.
 *
 * Nullable with no backfill: a session that is queued or has already exited
 * when this migration runs has no token, which is exactly what NULL means. The
 * unique index stops two sessions from sharing one credential; SQLite treats
 * NULLs as distinct, so sessions without a token do not collide.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE sessions ADD COLUMN token_hash TEXT`;
  yield* sql`CREATE UNIQUE INDEX sessions_token_hash ON sessions (token_hash)`;
});
