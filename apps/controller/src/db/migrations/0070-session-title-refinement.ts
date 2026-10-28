/**
 * Adds `sessions.needs_refinement`: whether the generated title of a Thread
 * was judged too vague to be good, because the first message held too little to go on.
 *
 * The column is `NULL` for a session that never got a generated title, which
 * is every session that exists now and every session whose title generation
 * failed or did not apply. `0` and `1` mean a title was generated. The value
 * records whether the model asked for it to be refined once the conversation
 * holds more. Nothing reads the column yet, and the contract's `Session` does not
 * expose it.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE sessions ADD COLUMN needs_refinement INTEGER
      CHECK (needs_refinement IN (0, 1))
  `;
});
