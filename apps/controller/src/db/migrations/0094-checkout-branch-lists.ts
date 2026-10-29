/**
 * Drops `checkouts.branches` and `checkouts.remote_branches`, the branch lists
 * each workspace report carried.
 *
 * A repository can have tens of thousands of branches, and every checkout
 * stored its full list, so the workspace list grew to many megabytes and took
 * longer to load than a client waits. The branches are now read live from the
 * runner by `resource.listBranches`, filtered and cut to a limit, and nothing
 * reads these columns.
 *
 * Dropping a column removes data nothing reads and rewrites no value that is
 * kept.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE checkouts DROP COLUMN branches`;
  yield* sql`ALTER TABLE checkouts DROP COLUMN remote_branches`;
});
