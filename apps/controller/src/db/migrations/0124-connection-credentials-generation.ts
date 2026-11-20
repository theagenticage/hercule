/**
 * Adds `connections.credentials_generation`: a counter that goes up each time
 * the user replaces the Connection's credentials (pasting new credentials or
 * signing in again). A new Connection starts at 0. An ordinary token refresh
 * does not write it.
 *
 * The MCP gateway closes its session with an outside MCP server when the
 * user reconnects, because the new credentials may point at another
 * destination, and keeps it across a refresh. A counter tells two
 * replacements apart even when they happen in the same millisecond, which a
 * timestamp does not.
 *
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE connections ADD COLUMN credentials_generation INTEGER NOT NULL DEFAULT 0`;
});
