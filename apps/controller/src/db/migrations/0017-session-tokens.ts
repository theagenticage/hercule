/**
 * The hash of the session's own credential on the public API.
 *
 * A column rather than a table: resolving a presented token is one indexed
 * lookup that has to read the session's permission profile anyway, and a
 * session has exactly one live token at a time - a resume replaces it, and an
 * exit kills it by status rather than by a revocation row nobody would read.
 *
 * Nullable with no backfill: a session queued or already exited when this lands
 * holds no token, which is exactly what NULL says. The unique index is what
 * makes two sessions unable to share one credential; SQLite treats NULLs as
 * distinct, so the sessions without one do not collide.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE sessions ADD COLUMN token_hash TEXT`;
  yield* sql`CREATE UNIQUE INDEX sessions_token_hash ON sessions (token_hash)`;
});
