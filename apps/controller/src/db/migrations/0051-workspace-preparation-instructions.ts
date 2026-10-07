/**
 * Keeps each new workspace's creation instruction unchanged on reconnect.
 * Existing rows have no original instruction to recover and retain their
 * legacy reconstruction until a current instruction can be recorded.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE workspaces ADD COLUMN provision_frame TEXT
            CHECK (provision_frame IS NULL OR json_valid(provision_frame))`;
});
