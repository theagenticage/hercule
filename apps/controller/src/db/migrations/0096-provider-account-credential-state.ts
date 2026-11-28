/**
 * Adds two columns to `provider_accounts` that describe the account's
 * credential:
 *
 * - `credential_expires_at`: when the account's token stops working. Only an
 *   account whose credential is a token Hercule made (a Claude subscription
 *   token, valid for one year) has a value. Every other account keeps NULL.
 * - `credential_generation`: a counter that goes up each time the account gets
 *   a new credential or a sign-in is accepted. A probe carries the number it
 *   was sent under, so an answer to a probe sent before the change is not
 *   stored as if it described the new credential. Every existing row starts
 *   at 0.
 *
 * Both columns get their value from a default, so the migration rewrites no
 * row.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE provider_accounts ADD COLUMN credential_expires_at TEXT`;
  yield* sql`ALTER TABLE provider_accounts ADD COLUMN credential_generation INTEGER NOT NULL DEFAULT 0`;
});
