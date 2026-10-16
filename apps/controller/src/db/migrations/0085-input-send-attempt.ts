/**
 * Adds `session_inputs.send_attempt`: how many times the input has been
 * claimed for a send. Every claim adds one in the same update that sets
 * `sent_at`, so each send of an input has a number no other send of it has.
 *
 * The number is what the runner's answer names. The claim time cannot do it:
 * it has millisecond precision, and two claims of one input can share a
 * millisecond, or the clock can step back between them. Rows that exist
 * already start at 0, which is below the number of any claim from now on.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE session_inputs ADD COLUMN send_attempt INTEGER NOT NULL DEFAULT 0`;
});
