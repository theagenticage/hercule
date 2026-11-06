/**
 * Adds `provider_accounts.plan_label_probed_at`, the time of the probe that
 * set the account's `plan_label`. A probe answer replaces the plan only when
 * the probe was sent after this time, so a late answer from one runner never
 * overwrites a newer plan another runner reported.
 *
 * The column is nullable. It is `NULL` while the account has no plan from a
 * probe: for a new account, after a new credential, and for an account whose
 * plan was stored before this column existed. `NULL` counts as older than
 * every probe, so the next matching probe sets the plan. No rows are rewritten.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE provider_accounts ADD COLUMN plan_label_probed_at TEXT`;
});
