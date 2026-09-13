/**
 * A redirect flow in progress: what the user chose before the browser left for
 * the provider, and the PKCE verifier the exchange has to prove itself with.
 *
 * The `state` is the row's whole identity, because it is the only thing the
 * provider hands back. A row is deleted the moment it is presented, so a state
 * spends once, and rows nobody came back for are swept on the next start.
 *
 * A pending setup is never a connection: nothing outside this table knows about
 * it, and a flow that is abandoned leaves no record and no secret behind.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE oauth_setups (
      state TEXT PRIMARY KEY NOT NULL,
      plugin_id TEXT NOT NULL,
      type TEXT NOT NULL,
      connection_id BLOB,
      label TEXT NOT NULL,
      labels TEXT NOT NULL CHECK (json_valid(labels)),
      config TEXT NOT NULL CHECK (json_valid(config)),
      origin TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
