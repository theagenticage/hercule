/**
 * The request the session's harness is waiting on, if any.
 *
 * It is stored on the row rather than derived from the stream for two reasons:
 *
 * - the operation that answers a request has to validate against it (is a
 *   request open, is it this one, is this decision offered) before anything is
 *   sent to the runner;
 * - every client already refetches this row when the session changes.
 *
 * Nullable with no backfill: a session that is running when this migration
 * runs is waiting on nothing, which is exactly what NULL means.
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
