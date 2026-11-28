/**
 * Adds `model_catalogs.first_read_at`: when the account's first successful
 * catalog read ended (spec 06 section 17.5). It is NULL until a read succeeds,
 * is set by that read, and never changes after.
 *
 * The first read is the line between the models a Model Profile was filled
 * with and the models that arrived later. It cannot be taken from `first_seen`:
 * when the first successful read lists no model, `first_seen` stays empty, and
 * the first read that lists some would look like the first one.
 *
 * Rows that were read get the earliest time in their `first_seen` ledger,
 * because every model of the first read is recorded at the time of that read.
 * A row whose ledger is empty gets `read_at`, the best time still known. A row
 * that was never read stays NULL.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE model_catalogs ADD COLUMN first_read_at TEXT`;
  yield* sql`
    UPDATE model_catalogs
    SET first_read_at = COALESCE((SELECT min(value) FROM json_each(model_catalogs.first_seen)), read_at)
    WHERE read_at IS NOT NULL
  `;
});
