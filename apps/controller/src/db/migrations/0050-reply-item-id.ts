/**
 * Records which assistant text a reply holds: `item_id` is the id of the
 * text's item in the session's transcript. A client reads it to tell which of
 * a running turn's texts are already stored, so it never draws a text twice.
 *
 * It is null on an owner message, on a notice, and on a reply that joins
 * several texts, which a `turn-end` turn stores when it fails or is stopped.
 * Every message that exists already is null too: which text an earlier reply
 * held was never recorded.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE conversation_messages ADD COLUMN item_id TEXT`;
});
