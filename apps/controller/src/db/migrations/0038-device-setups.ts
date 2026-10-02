/**
 * A device flow in progress: what the user chose when the flow started, the
 * device code the controller polls the provider with, and when it may poll
 * next.
 *
 * `setup_id` is the row's identity. It is what the client polls with, and it
 * is minted by the controller rather than taken from the provider, so the
 * provider's device code never leaves the controller: anyone who held it could
 * collect the token once the user approves. The device code is stored as
 * plain text, like the redirect flow's PKCE verifier, because the controller
 * has to send it back to the provider as it is.
 *
 * A row is deleted as soon as a poll ends the flow, so a flow ends only once.
 * Rows for flows nobody finished are deleted on the next start.
 *
 * `next_poll_at` is the earliest time the controller asks the provider again.
 * A poll that comes earlier is answered from this row without calling the
 * provider, which keeps the controller inside the interval the provider set
 * however often a client polls.
 *
 * `type` is the qualified type, which includes the plugin that owns the flow,
 * so no second column is needed for the owner.
 *
 * A pending setup is never a connection: nothing outside this table knows about
 * it, and a flow that is abandoned leaves no connection and no secret behind.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE device_setups (
      setup_id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL,
      connection_id BLOB,
      label TEXT NOT NULL,
      labels TEXT NOT NULL CHECK (json_valid(labels)),
      config TEXT NOT NULL CHECK (json_valid(config)),
      device_code TEXT NOT NULL,
      interval_seconds INTEGER NOT NULL CHECK (interval_seconds > 0),
      next_poll_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
