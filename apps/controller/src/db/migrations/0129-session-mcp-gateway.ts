/**
 * Adds `sessions.mcp_gateway`: whether the session's last start gave its
 * harness the MCP Gateway's entry, and if not, why not (spec 21 section 3.8).
 *
 * The value is `given`, `runner-too-old` or `harness-unsupported`. It is
 * kept because a session keeps running across a controller upgrade, which can
 * change what a new start would decide, and the warning for servers added to a
 * running session must follow what the session actually got.
 *
 * The column is nullable. Null means no start has written it: every session
 * that exists when this migration runs, and a session whose start was never
 * claimed.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE sessions ADD COLUMN mcp_gateway TEXT`;
});
