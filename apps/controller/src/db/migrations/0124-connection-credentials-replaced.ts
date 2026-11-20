/**
 * Adds `connections.credentials_replaced_at`: when the user last replaced the
 * Connection's credentials (creating it, pasting new credentials, or signing
 * in again). An ordinary token refresh does not write it.
 *
 * The MCP gateway closes its session with an outside MCP server when the
 * user reconnects, because the new credentials may point at another
 * destination, and keeps it across a refresh.
 *
 * Existing Connections get NULL: nothing has been waiting on a reconnect yet.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE connections ADD COLUMN credentials_replaced_at TEXT`;
});
