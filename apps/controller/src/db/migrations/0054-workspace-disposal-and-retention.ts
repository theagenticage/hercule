/** Preserves populated workspace relationships while adding durable removal intent and manual retention. */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE workspaces_next (
      id BLOB PRIMARY KEY NOT NULL,
      runner_id BLOB NOT NULL REFERENCES runners(id),
      kind TEXT NOT NULL CHECK (kind IN ('primary', 'ephemeral')),
      status TEXT NOT NULL CHECK (status IN ('provisioning', 'ready', 'failed', 'disposing', 'deleted', 'lost')),
      message TEXT,
      designated_connection_id BLOB REFERENCES connections(id),
      created_at TEXT NOT NULL,
      provisioned_at TEXT,
      last_used_at TEXT,
      disposed_at TEXT,
      preparation_instruction TEXT CHECK (preparation_instruction IS NULL OR json_valid(preparation_instruction)),
      ownership TEXT NOT NULL DEFAULT 'managed' CHECK (ownership IN ('managed', 'adopted')),
      path TEXT,
      observed_at TEXT,
      available INTEGER CHECK (available IN (0, 1)),
      warnings TEXT NOT NULL DEFAULT '[]',
      derived_workspace_ids TEXT CHECK (derived_workspace_ids IS NULL OR json_valid(derived_workspace_ids)),
      retention_policy TEXT NOT NULL DEFAULT 'automatic' CHECK (retention_policy IN ('manual', 'automatic')),
      removal_instruction TEXT CHECK (removal_instruction IS NULL OR json_valid(removal_instruction)),
      disposal_previous_status TEXT CHECK (disposal_previous_status IN ('provisioning', 'ready', 'failed')),
      disposal_audit TEXT CHECK (disposal_audit IS NULL OR json_valid(disposal_audit))
    )
  `;
  yield* sql`
    INSERT INTO workspaces_next (id, runner_id, kind, status, message, designated_connection_id,
      created_at, provisioned_at, last_used_at, disposed_at, preparation_instruction, ownership, path,
      observed_at, available, warnings, derived_workspace_ids, retention_policy)
    SELECT id, runner_id, kind, status, message, designated_connection_id,
      created_at, provisioned_at, last_used_at, disposed_at, preparation_instruction, ownership, path,
      observed_at, available, warnings, derived_workspace_ids,
      CASE WHEN EXISTS (SELECT 1 FROM sessions s WHERE s.workspace_id = workspaces.id AND s.agent_id IS NULL)
        THEN 'manual' ELSE 'automatic' END
    FROM workspaces
  `;
  // Rebuild every child before dropping the old parent. Foreign keys stay on,
  // including inside the migration transaction, and never point at a missing table.
  yield* sql`
    CREATE TABLE checkouts_next (
      id BLOB PRIMARY KEY NOT NULL,
      workspace_id BLOB NOT NULL REFERENCES workspaces_next(id),
      resource_id BLOB NOT NULL REFERENCES resources(id),
      form TEXT NOT NULL CHECK (form IN ('clone', 'worktree')),
      subdirectory TEXT,
      branch TEXT,
      branches TEXT NOT NULL CHECK (json_valid(branches)),
      default_branch TEXT,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      base_branch TEXT,
      starting_revision TEXT,
      base_commit TEXT,
      head_commit TEXT,
      remote_branches TEXT NOT NULL DEFAULT '[]'
    )
  `;
  yield* sql`INSERT INTO checkouts_next SELECT * FROM checkouts`;
  yield* sql`
    CREATE TABLE workspace_leases_next (
      workspace_id BLOB NOT NULL REFERENCES workspaces_next(id),
      holder_kind TEXT NOT NULL CHECK (holder_kind IN ('session', 'run')),
      holder_id BLOB NOT NULL,
      acquired_at TEXT NOT NULL,
      released_at TEXT,
      retention TEXT CHECK (retention IN ('none', 'orphan', 'idle', 'inspection')),
      kept_until TEXT,
      CHECK ((released_at IS NULL) = (retention IS NULL) AND (released_at IS NULL) = (kept_until IS NULL)),
      PRIMARY KEY (workspace_id, holder_kind, holder_id)
    )
  `;
  yield* sql`INSERT INTO workspace_leases_next SELECT * FROM workspace_leases`;
  yield* sql`
    CREATE TABLE workspace_repositories_next (
      resource_id BLOB NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      runner_id BLOB NOT NULL REFERENCES runners(id),
      mode TEXT NOT NULL CHECK (mode IN ('managed', 'existing')),
      path TEXT,
      remote_name TEXT,
      primary_workspace_id BLOB REFERENCES workspaces_next(id),
      CHECK ((mode = 'existing' AND path IS NOT NULL AND remote_name IS NOT NULL)
        OR (mode = 'managed' AND path IS NULL AND remote_name IS NULL)),
      PRIMARY KEY (resource_id, runner_id)
    ) WITHOUT ROWID
  `;
  yield* sql`INSERT INTO workspace_repositories_next SELECT * FROM workspace_repositories`;
  yield* sql`DROP TABLE checkouts`;
  yield* sql`DROP TABLE workspace_leases`;
  yield* sql`DROP TABLE workspace_repositories`;
  yield* sql`DROP TABLE workspaces`;
  yield* sql`ALTER TABLE workspaces_next RENAME TO workspaces`;
  yield* sql`ALTER TABLE checkouts_next RENAME TO checkouts`;
  yield* sql`ALTER TABLE workspace_leases_next RENAME TO workspace_leases`;
  yield* sql`ALTER TABLE workspace_repositories_next RENAME TO workspace_repositories`;
  yield* sql`CREATE INDEX workspaces_runner ON workspaces(runner_id, status)`;
  yield* sql`CREATE INDEX checkouts_workspace ON checkouts(workspace_id, position)`;
  yield* sql`CREATE INDEX checkouts_resource ON checkouts(resource_id)`;
  yield* sql`CREATE INDEX workspace_leases_holder ON workspace_leases(holder_kind, holder_id)`;
});
