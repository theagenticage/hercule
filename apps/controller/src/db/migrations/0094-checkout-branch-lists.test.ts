import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Struct from "effect/Struct";
import { TestDatabaseWriter } from "../testing";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

describe("dropping the stored branch lists", () => {
  it("drops the two columns and keeps every other value of a checkout", async () => {
    const { before, after } = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(migrations.filter(([id]) => id < 94));
        yield* sql`INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels, credential_hash, created_at, updated_at)
        VALUES ('runner', 'laptop', 'online', 'active', 0, '{}', 'hash', 'old', 'old')`;
        yield* sql`INSERT INTO resources (id, kind, remote, canonical_remote, workspace_include, created_at, updated_at)
        VALUES ('repo', 'repo', 'https://github.com/acme/main', 'github.com/acme/main', 1, 'old', 'old')`;
        yield* sql`INSERT INTO workspaces (id, runner_id, kind, status, created_at, ownership, warnings)
        VALUES ('main', 'runner', 'primary', 'ready', 'old', 'managed', '[]')`;
        yield* sql`INSERT INTO checkouts (id, workspace_id, resource_id, form, subdirectory, branch, branches, default_branch, position, created_at, base_branch, starting_revision, base_commit, head_commit, remote_branches)
        VALUES ('checkout', 'main', 'repo', 'clone', null, 'feature', '["feature","main"]', 'main', 0, 'old', null, '{"kind":"current"}', 'base', 'head', '["main"]')`;
        const before = yield* sql<Record<string, unknown>>`SELECT * FROM checkouts`;
        yield* runMigrations(migrations.filter(([id]) => id <= 94));
        const after = yield* sql<Record<string, unknown>>`SELECT * FROM checkouts`;
        return { before, after };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(after).toEqual([Struct.omit(before[0]!, ["branches", "remote_branches"])]);
  });
});
