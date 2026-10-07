import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

describe("workspace preparation instructions migration", () => {
  it("preserves existing workspace rows without inventing original instructions", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(migrations.filter(([id]) => id < 51));
        yield* sql`
          INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels,
                               credential_hash, created_at, updated_at)
          VALUES ('runner', 'laptop', 'online', 'active', 0, '{}', 'hash', 'old', 'old')`;
        yield* sql`
          INSERT INTO workspaces (id, runner_id, kind, status, message, created_at)
          VALUES ('main', 'runner', 'primary', 'ready', NULL, 'old'),
                 ('preparing', 'runner', 'ephemeral', 'provisioning', NULL, 'old'),
                 ('failed', 'runner', 'ephemeral', 'failed', 'exit 7', 'old')`;
        const before = yield* sql`SELECT * FROM workspaces ORDER BY id`;
        yield* runMigrations(migrations.filter(([id]) => id <= 51));
        const after = yield* sql`SELECT * FROM workspaces ORDER BY id`;
        const violations = yield* sql`PRAGMA foreign_key_check`;
        return { before, after, violations };
      }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
    );
    expect(result.after).toEqual(result.before.map((row) => ({ ...row, provision_frame: null })));
    expect(result.violations).toEqual([]);
  });
});
