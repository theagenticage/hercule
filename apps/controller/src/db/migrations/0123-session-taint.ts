/**
 * Adds `sessions.tainted`: whether the session has read third-party messages
 * (spec 13 section 10). It is 1 from the moment the core delivers the session
 * a line wrapped as data, and nothing clears it.
 *
 * Every existing session gets 0: no channel has delivered a wrapped line yet,
 * so no session has read third-party text.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE sessions ADD COLUMN tainted INTEGER NOT NULL DEFAULT 0 CHECK (tainted IN (0, 1))`;
});
