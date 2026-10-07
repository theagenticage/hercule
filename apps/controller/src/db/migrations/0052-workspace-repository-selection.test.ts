import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

describe("workspace repository selection migration", () => {
  it("preserves legacy rows and leases while selecting managed storage without inventing main workspaces", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(migrations.filter(([id]) => id < 52));
        yield* sql`
          INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels,
                               credential_hash, created_at, updated_at)
          VALUES ('runner', 'laptop', 'online', 'active', 0, '{}', 'hash', 'old', 'old')`;
        yield* sql`
          INSERT INTO resources (id, kind, remote, canonical_remote, workspace_include, created_at, updated_at)
          VALUES ('repo', 'repo', 'https://github.com/acme/main', 'github.com/acme/main', 1, 'old', 'old'),
                 ('workflow-repo', 'repo', 'https://github.com/acme/workflow', 'github.com/acme/workflow', 1, 'old', 'old')`;
        yield* sql`
          INSERT INTO workspaces (id, runner_id, kind, status, created_at)
          VALUES ('main', 'runner', 'primary', 'ready', 'old'),
                 ('derived', 'runner', 'ephemeral', 'ready', 'old'),
                 ('workflow', 'runner', 'ephemeral', 'failed', 'old')`;
        yield* sql`
          INSERT INTO checkouts (id, workspace_id, resource_id, form, branch, branches, position, created_at)
          VALUES ('main-checkout', 'main', 'repo', 'clone', 'local-branch', '["local-branch"]', 0, 'old'),
                 ('derived-checkout', 'derived', 'repo', 'worktree', 'thread-branch', '["thread-branch"]', 0, 'old'),
                 ('workflow-checkout', 'workflow', 'workflow-repo', 'worktree', 'run-branch', '["run-branch"]', 0, 'old')`;
        yield* sql`
          INSERT INTO workspace_leases (workspace_id, holder_kind, holder_id, acquired_at)
          VALUES ('derived', 'session', 'thread', 'old')`;
        const beforeWorkspaces = yield* sql`SELECT * FROM workspaces ORDER BY id`;
        const beforeCheckouts = yield* sql`SELECT * FROM checkouts ORDER BY id`;
        const beforeLeases = yield* sql`SELECT * FROM workspace_leases`;

        yield* runMigrations(migrations.filter(([id]) => id <= 52));

        const workspaces = yield* sql`SELECT * FROM workspaces ORDER BY id`;
        const checkouts = yield* sql`SELECT * FROM checkouts ORDER BY id`;
        const leases = yield* sql`SELECT * FROM workspace_leases`;
        const selections = yield* sql`SELECT * FROM workspace_repositories ORDER BY resource_id`;
        const violations = yield* sql`PRAGMA foreign_key_check`;
        // Resource deletion already removes its checkouts. The new selection
        // must disappear with the Resource rather than blocking that operation.
        yield* sql`DELETE FROM checkouts WHERE resource_id = 'repo'`;
        yield* sql`DELETE FROM resources WHERE id = 'repo'`;
        const remainingSelections = yield* sql`SELECT resource_id FROM workspace_repositories`;
        return {
          beforeWorkspaces,
          beforeCheckouts,
          beforeLeases,
          workspaces,
          checkouts,
          leases,
          selections,
          violations,
          remainingSelections,
        };
      }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
    );
    expect(result.workspaces).toEqual(
      result.beforeWorkspaces.map((row) => ({ ...row, ownership: "managed", path: null })),
    );
    expect(result.checkouts).toEqual(result.beforeCheckouts);
    expect(result.leases).toEqual(result.beforeLeases);
    expect(result.selections).toEqual([
      {
        resource_id: "repo",
        runner_id: "runner",
        mode: "managed",
        path: null,
        remote_name: null,
        primary_workspace_id: "main",
      },
      {
        resource_id: "workflow-repo",
        runner_id: "runner",
        mode: "managed",
        path: null,
        remote_name: null,
        primary_workspace_id: null,
      },
    ]);
    expect(result.violations).toEqual([]);
    expect(result.remainingSelections).toEqual([{ resource_id: "workflow-repo" }]);
  });
});
