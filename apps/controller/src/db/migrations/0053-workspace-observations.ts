/** Preserves creation facts separately from the runner's latest Git observation. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE workspaces ADD COLUMN observed_at TEXT`;
  yield* sql`ALTER TABLE workspaces ADD COLUMN available INTEGER CHECK (available IN (0, 1))`;
  yield* sql`ALTER TABLE workspaces ADD COLUMN warnings TEXT NOT NULL DEFAULT '[]'`;
  yield* sql`ALTER TABLE workspaces ADD COLUMN derived_workspace_ids TEXT
            CHECK (derived_workspace_ids IS NULL OR json_valid(derived_workspace_ids))`;
  yield* sql`ALTER TABLE checkouts ADD COLUMN starting_revision TEXT`;
  yield* sql`ALTER TABLE checkouts ADD COLUMN base_commit TEXT`;
  yield* sql`ALTER TABLE checkouts ADD COLUMN head_commit TEXT`;
  yield* sql`ALTER TABLE checkouts ADD COLUMN remote_branches TEXT NOT NULL DEFAULT '[]'`;
});
