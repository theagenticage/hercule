/**
 * Adds three nullable columns to `provider_accounts` that describe whether the
 * account's credential works:
 *
 * - `failure_message`: the provider's words when it refused the account's
 *   credential. NULL while the account is not failed.
 * - `failed_at`: when the account turned failed. NULL exactly when
 *   `failure_message` is.
 * - `expiry_notified_at`: when the "credential expires soon" notification was
 *   raised for the current credential. NULL until then. A new credential sets
 *   it back to NULL, so the warning fires again for the new one.
 *
 * Every existing row starts with all three NULL, so the migration rewrites no
 * row.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE provider_accounts ADD COLUMN failure_message TEXT`;
  yield* sql`ALTER TABLE provider_accounts ADD COLUMN failed_at TEXT`;
  yield* sql`ALTER TABLE provider_accounts ADD COLUMN expiry_notified_at TEXT`;
});
