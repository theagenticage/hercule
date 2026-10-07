/** Preserves each runner's fixed repository choice independently of its main working copy. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE workspaces ADD COLUMN ownership TEXT NOT NULL DEFAULT 'managed'
            CHECK (ownership IN ('managed', 'adopted'))`;
  yield* sql`ALTER TABLE workspaces ADD COLUMN path TEXT`;
  yield* sql`
    CREATE TABLE workspace_repositories (
      resource_id BLOB NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      runner_id BLOB NOT NULL REFERENCES runners(id),
      mode TEXT NOT NULL CHECK (mode IN ('managed', 'existing')),
      path TEXT,
      remote_name TEXT,
      primary_workspace_id BLOB REFERENCES workspaces(id),
      CHECK ((mode = 'existing' AND path IS NOT NULL AND remote_name IS NOT NULL)
          OR (mode = 'managed' AND path IS NULL AND remote_name IS NULL)),
      PRIMARY KEY (resource_id, runner_id)
    ) WITHOUT ROWID
  `;
  // Physical Git topology stays in the runner registry. Historical clones and
  // cache worktrees both represent managed choices, without moving any files.
  yield* sql`
    INSERT INTO workspace_repositories (resource_id, runner_id, mode, primary_workspace_id)
    SELECT DISTINCT c.resource_id, w.runner_id, 'managed', (
      SELECT p.id FROM workspaces p JOIN checkouts pc ON pc.workspace_id = p.id
      WHERE p.runner_id = w.runner_id AND pc.resource_id = c.resource_id
        AND p.kind = 'primary' AND p.status IN ('provisioning', 'ready')
      ORDER BY p.created_at DESC LIMIT 1
    )
    FROM checkouts c JOIN workspaces w ON w.id = c.workspace_id
  `;
});
