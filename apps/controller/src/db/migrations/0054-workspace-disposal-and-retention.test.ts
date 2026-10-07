import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

describe("durable workspace removal migration", () => {
  it("preserves populated workspace children, topology, observations and indices and retains historical human threads", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(migrations.filter(([id]) => id < 54));
        yield* sql`INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels, credential_hash, created_at, updated_at)
        VALUES ('runner', 'laptop', 'online', 'active', 0, '{}', 'hash', 'old', 'old')`;
        yield* sql`INSERT INTO resources (id, kind, remote, canonical_remote, workspace_include, created_at, updated_at)
        VALUES ('repo', 'repo', 'https://github.com/acme/main', 'github.com/acme/main', 1, 'old', 'old')`;
        yield* sql`INSERT INTO workspaces (id, runner_id, kind, status, message, created_at, provisioned_at, last_used_at, ownership, path, observed_at, available, warnings, provision_frame)
        VALUES ('main', 'runner', 'primary', 'ready', 'kept warning', 'old', 'prepared', 'used', 'existing', '/human/main', 'observed', 1, '["warning"]', '{"frozen":"original"}'),
          ('derived', 'runner', 'ephemeral', 'failed', 'setup failed', 'new', null, 'used', 'managed', null, null, null, '[]', null)`;
        yield* sql`INSERT INTO checkouts (id, workspace_id, resource_id, form, subdirectory, branch, branches, default_branch, position, created_at, base_branch, starting_revision, base_commit, head_commit, remote_branches)
        VALUES ('checkout', 'main', 'repo', 'clone', null, 'local-only', '["local-only"]', 'main', 0, 'old', 'deprecated', '{"kind":"current"}', 'base', 'head', '["origin/main"]'),
          ('derived-checkout', 'derived', 'repo', 'worktree', 'main', 'feature', '["feature"]', null, 0, 'new', null, null, null, null, '[]')`;
        yield* sql`INSERT INTO workspace_leases (workspace_id, holder_kind, holder_id, acquired_at, released_at, retention, kept_until)
        VALUES ('main', 'session', 'thread', 'old', 'released', 'idle', 'expired'),
          ('derived', 'run', 'workflow', 'new', null, null, null)`;
        yield* sql`INSERT INTO workspace_repositories (resource_id, runner_id, mode, path, remote_name, primary_workspace_id)
        VALUES ('repo', 'runner', 'existing', '/human/main', 'origin', 'main')`;
        yield* sql`INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id, workspace_id, requested_access_mode, access_mode, spec, title, status, created_at, last_activity_at, agent_id)
        VALUES ('thread', 'profile', 'provider', 'runner', 'main', 'default', 'default', '{}', 'human thread', 'exited', 'old', 'old', null),
          ('agent-session', 'profile', 'provider', 'runner', 'derived', 'default', 'default', '{}', 'agent work', 'exited', 'old', 'old', 'agent')`;
        const before = {
          workspaces: yield* sql`SELECT * FROM workspaces ORDER BY id`,
          checkouts: yield* sql`SELECT * FROM checkouts ORDER BY id`,
          leases: yield* sql`SELECT * FROM workspace_leases ORDER BY workspace_id`,
          repositories: yield* sql`SELECT * FROM workspace_repositories`,
          indices:
            yield* sql`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('workspaces', 'checkouts', 'workspace_leases', 'workspace_repositories') ORDER BY name`,
        };
        yield* runMigrations(migrations.filter(([id]) => id <= 54));
        const after = {
          workspaces: yield* sql`SELECT * FROM workspaces ORDER BY id`,
          checkouts: yield* sql`SELECT * FROM checkouts ORDER BY id`,
          leases: yield* sql`SELECT * FROM workspace_leases ORDER BY workspace_id`,
          repositories: yield* sql`SELECT * FROM workspace_repositories`,
          indices:
            yield* sql`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('workspaces', 'checkouts', 'workspace_leases', 'workspace_repositories') ORDER BY name`,
        };
        yield* sql`UPDATE workspaces SET status = 'disposing', disposal_frame = '{"_tag":"workspaceDetach","workspaceId":"main","requestId":"intent"}', disposal_previous_status = 'ready', disposal_audit = '{"actor":"user"}' WHERE id = 'main'`;
        return {
          before,
          after,
          violations: yield* sql`PRAGMA foreign_key_check`,
          foreignKeys: yield* sql`PRAGMA foreign_keys`,
          targets:
            yield* sql`SELECT "table" AS target FROM pragma_foreign_key_list('workspace_repositories') WHERE "from" = 'primary_workspace_id'`,
        };
      }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
    );
    expect(result.after.workspaces).toEqual(
      result.before.workspaces.map((row) => ({
        ...row,
        retention_policy: row.id === "main" ? "manual" : "automatic",
        disposal_frame: null,
        disposal_previous_status: null,
        disposal_audit: null,
      })),
    );
    expect(result.after.checkouts).toEqual(result.before.checkouts);
    expect(result.after.leases).toEqual(result.before.leases);
    expect(result.after.repositories).toEqual(result.before.repositories);
    expect(result.after.indices).toEqual(result.before.indices);
    expect(result.violations).toEqual([]);
    expect(result.foreignKeys).toEqual([{ foreign_keys: 1 }]);
    expect(result.targets).toEqual([{ target: "workspaces" }]);
  });
});
