import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

describe("workspace observation migration", () => {
  it("preserves legacy topology and leases while leaving unobserved facts unknown", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(migrations.filter(([id]) => id < 53));
        yield* sql`INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels, credential_hash, created_at, updated_at)
        VALUES ('runner', 'laptop', 'online', 'active', 0, '{}', 'hash', 'old', 'old')`;
        yield* sql`INSERT INTO resources (id, kind, remote, canonical_remote, workspace_include, created_at, updated_at)
        VALUES ('repo', 'repo', 'https://github.com/acme/main', 'github.com/acme/main', 1, 'old', 'old')`;
        yield* sql`INSERT INTO workspaces (id, runner_id, kind, status, created_at, provisioned_at)
        VALUES ('main', 'runner', 'primary', 'ready', 'old', 'ready')`;
        yield* sql`INSERT INTO checkouts (id, workspace_id, resource_id, form, branch, branches, position, created_at)
        VALUES ('checkout', 'main', 'repo', 'clone', 'local-only', '["local-only"]', 0, 'old')`;
        yield* sql`INSERT INTO workspace_leases (workspace_id, holder_kind, holder_id, acquired_at)
        VALUES ('main', 'session', 'thread', 'old')`;
        const beforeWorkspace = yield* sql`SELECT * FROM workspaces`;
        const beforeCheckout = yield* sql`SELECT * FROM checkouts`;
        const beforeLeases = yield* sql`SELECT * FROM workspace_leases`;
        yield* runMigrations(migrations.filter(([id]) => id <= 53));
        return {
          beforeWorkspace,
          beforeCheckout,
          beforeLeases,
          workspace: yield* sql`SELECT * FROM workspaces`,
          checkout: yield* sql`SELECT * FROM checkouts`,
          leases: yield* sql`SELECT * FROM workspace_leases`,
          violations: yield* sql`PRAGMA foreign_key_check`,
        };
      }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
    );
    expect(result.workspace).toEqual(
      result.beforeWorkspace.map((row) => ({
        ...row,
        observed_at: null,
        derived_workspace_ids: null,
        warnings: "[]",
        available: null,
      })),
    );
    expect(result.checkout).toEqual(
      result.beforeCheckout.map((row) => ({
        ...row,
        starting_revision: null,
        base_commit: null,
        head_commit: null,
        remote_branches: "[]",
      })),
    );
    expect(result.leases).toEqual(result.beforeLeases);
    expect(result.violations).toEqual([]);
  });
});
