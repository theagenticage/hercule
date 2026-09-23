/**
 * A redirect flow in progress: what the user chose before the browser went to
 * the provider, and the PKCE verifier the token exchange has to send.
 *
 * The `state` is the row's whole identity, because it is the only value the
 * provider sends back. A row is deleted as soon as its state is presented, so a
 * state works only once, and rows for flows nobody finished are deleted on the
 * next start.
 *
 * `type` is the qualified type, which includes the plugin that owns the flow,
 * so no second column is needed for the owner.
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
