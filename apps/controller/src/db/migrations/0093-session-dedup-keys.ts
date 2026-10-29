/**
 * Adds `session_dedup_keys`: the keys an actor sent with `session.spawn`,
 * `session.continue` and `session.input`, each with the id the first call
 * with that key returned. A repeat of a call (an agent retrying after a
 * timeout) finds its key here and gets the first call's id back instead of
 * starting a second session or sending a second message.
 *
 * A key is unique per actor, operation and key text. Two actors may use the
 * same text. So may two operations, for example `session.spawn` and
 * `session.input`. `result_id` is the id of the session (`session.spawn`,
 * `session.continue`) or of the input (`session.input`) the call returned.
 *
 * The keys have a table of their own, not a column on `sessions` or
 * `session_inputs`, for two reasons:
 *
 * - `session_inputs.actor` changes when someone edits a waiting input, which
 *   would silently free the key of the call that sent it.
 * - `session.spawn` and `session.continue` both write `sessions`, and one
 *   column there could not tell their keys apart.
 *
 * A key is never deleted. The migration only adds a table and rewrites no row.
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
