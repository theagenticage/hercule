/**
 * The request the session's harness is parked on, if any.
 *
 * On the row rather than derived from the stream because the answer operation
 * has to validate against it - is a request open, is it this one, is this
 * decision offered - before anything crosses the wire, and because every
 * surface already refetches this row when the session changes.
 *
 * Nullable with no backfill: a session running when this lands is parked on
 * nothing, which is exactly what NULL says.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE sessions ADD COLUMN open_request TEXT
      CHECK (open_request IS NULL OR json_valid(open_request))
  `;
});
