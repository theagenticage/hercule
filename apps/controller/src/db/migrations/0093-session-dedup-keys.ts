/**
 * Adds `session_dedup_keys`: the keys an actor sent with `session.spawn`,
 * `session.continue` and `session.input`, each with the id the first call
 * returned (a session or an input). A call looks its key up and records it in
 * the transaction that writes its result, so a repeat finds the key here and
 * gets that id back without writing anything.
 *
 * The keys have a table of their own, not a column on `sessions` or
 * `session_inputs`:
 *
 * - `session_inputs.actor` changes when someone edits a waiting input, which
 *   would free the key of the call that sent it.
 * - `session.spawn` and `session.continue` both write `sessions`, and one
 *   column there could not tell their keys apart.
 *
 * The migration only adds a table and rewrites no row.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE session_dedup_keys (
      actor TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('session.spawn', 'session.continue', 'session.input')),
      dedup_key TEXT NOT NULL,
      result_id BLOB NOT NULL,
      PRIMARY KEY (actor, operation, dedup_key)
    ) WITHOUT ROWID
  `;
});
