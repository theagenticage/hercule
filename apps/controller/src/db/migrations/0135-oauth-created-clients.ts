/**
 * Adds what a redirect flow needs when a Connection signs in with an OAuth
 * client that its plugin created for it, and when the browser comes back to
 * the user's own machine instead of to the controller.
 *
 * - `connections.oauth_client_id`: the id of the client the plugin created for
 *   this Connection. The refresh sends it. NULL for every Connection whose
 *   client is shipped by its plugin, set in the plugin's settings, or not
 *   OAuth at all. It is not a secret: the client has none.
 * - `oauth_setups.client_id`: the id of the client a flow runs as, for a type
 *   that creates a client for each Connection. NULL for any other flow.
 * - `oauth_setups.redirect_uri`: the exact redirect URI of a flow whose
 *   browser comes back to the user's own machine. NULL for a flow that comes
 *   back to the controller, whose redirect URI is its `origin` followed by the
 *   callback path.
 * - `oauth_setups.actor`: who started the flow (`user` or `session:<id>`), so
 *   that only that caller can finish a flow that returns to the user's
 *   machine, and the Connection it writes is stamped with the same actor.
 *   NULL for a flow that started before this migration, which the user
 *   started.
 * - `oauth_setups.credentials_generation`: the Connection's
 *   `credentials_generation` when a reconnect started. The write refuses to
 *   replace credentials that changed since, so of two reconnects the first to
 *   finish wins. NULL for a new Connection and for a flow that started before
 *   this migration.
 *
 * Only columns are added, and no row is rewritten.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE connections ADD COLUMN oauth_client_id TEXT`;
  yield* sql`ALTER TABLE oauth_setups ADD COLUMN client_id TEXT`;
  yield* sql`ALTER TABLE oauth_setups ADD COLUMN redirect_uri TEXT`;
  yield* sql`ALTER TABLE oauth_setups ADD COLUMN actor TEXT`;
  yield* sql`ALTER TABLE oauth_setups ADD COLUMN credentials_generation INTEGER`;
});
