/**
 * Tests what the archived sessions migration does to a database at the
 * previous head: every workspace lease survives the rebuild, a lease can now
 * be released with the `archived` retention, and the checks on the new session
 * columns and on the lease still refuse bad rows.
 *
 * The tests stop at this migration, so a later migration cannot change what
 * they check.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../migrate";
import { TestDatabaseWriter } from "../testing";
import { migrations } from "./index";

const BEFORE = migrations.filter(([id]) => id < 104);
const UP_TO_ARCHIVED_SESSIONS = migrations.filter(([id]) => id <= 104);

/** Writes a runner, a workspace and two sessions, one of them Done, as the previous head stores them. */
const insertWorkspaceWithSessions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels, credential_hash, created_at, updated_at)
             VALUES ('runner', 'laptop', 'online', 'active', 0, '{}', 'hash', 'old', 'old')`;
  yield* sql`INSERT INTO workspaces (id, runner_id, kind, status, created_at, ownership, warnings)
             VALUES ('workspace', 'runner', 'ephemeral', 'ready', 'old', 'managed', '[]')`;
  yield* sql`INSERT INTO sessions (id, permission_profile_id, provider_account_id, runner_id, workspace_id, requested_access_mode, access_mode, spec, title, status, created_at, last_activity_at, done_at, done_by)
             VALUES ('open', 'profile', 'provider', 'runner', 'workspace', 'default', 'default', '{}', 'open thread', 'exited', 'old', 'old', null, null),
               ('done', 'profile', 'provider', 'runner', 'workspace', 'default', 'default', '{}', 'done thread', 'exited', 'old', 'old', 'finished', 'user')`;
});

describe("the archived sessions migration", () => {
  it("keeps every lease, its primary key and its holder index, and accepts the archived retention", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* insertWorkspaceWithSessions;
        yield* sql`INSERT INTO workspace_leases (workspace_id, holder_kind, holder_id, acquired_at, released_at, retention, kept_until)
                   VALUES ('workspace', 'session', 'a-none', 't1', 't2', 'none', 't2'),
                     ('workspace', 'session', 'b-orphan', 't1', 't2', 'orphan', 't3'),
                     ('workspace', 'session', 'c-idle', 't1', 't2', 'idle', 't3'),
                     ('workspace', 'session', 'd-inspection', 't1', 't2', 'inspection', 't3'),
                     ('workspace', 'run', 'e-active', 't1', null, null, null)`;
        const before = yield* sql`SELECT * FROM workspace_leases ORDER BY holder_id`;
        yield* runMigrations(UP_TO_ARCHIVED_SESSIONS);
        const after = yield* sql`SELECT * FROM workspace_leases ORDER BY holder_id`;
        const indices =
          yield* sql`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workspace_leases'`;
        yield* sql`UPDATE workspace_leases SET released_at = 't4', retention = 'archived', kept_until = 't4'
                   WHERE holder_id = 'e-active'`;
        const archived =
          yield* sql`SELECT retention FROM workspace_leases WHERE holder_id = 'e-active'`;
        const duplicate = yield* Effect.flip(
          sql`INSERT INTO workspace_leases (workspace_id, holder_kind, holder_id, acquired_at)
              VALUES ('workspace', 'run', 'e-active', 't5')`,
        );
        return {
          before,
          after,
          indices,
          archived,
          duplicate: String(duplicate.cause.cause),
          violations: yield* sql`PRAGMA foreign_key_check`,
          foreignKeys: yield* sql`PRAGMA foreign_keys`,
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(result.before).toHaveLength(5);
    expect(result.after).toEqual(result.before);
    expect(result.indices).toContainEqual({ name: "workspace_leases_holder" });
    expect(result.archived).toEqual([{ retention: "archived" }]);
    expect(result.duplicate).toContain("UNIQUE constraint failed");
    expect(result.violations).toEqual([]);
    expect(result.foreignKeys).toEqual([{ foreign_keys: 1 }]);
  });

  it("still refuses an unknown retention and a half-released lease", async () => {
    const errors = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_ARCHIVED_SESSIONS);
        yield* insertWorkspaceWithSessions;
        const unknownRetention = yield* Effect.flip(
          sql`INSERT INTO workspace_leases (workspace_id, holder_kind, holder_id, acquired_at, released_at, retention, kept_until)
              VALUES ('workspace', 'session', 'x', 't1', 't2', 'forever', 't3')`,
        );
        const halfReleased = yield* Effect.flip(
          sql`INSERT INTO workspace_leases (workspace_id, holder_kind, holder_id, acquired_at, released_at, retention, kept_until)
              VALUES ('workspace', 'session', 'y', 't1', 't2', null, null)`,
        );
        return {
          unknownRetention: String(unknownRetention.cause.cause),
          halfReleased: String(halfReleased.cause.cause),
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(errors.unknownRetention).toContain("CHECK constraint failed");
    expect(errors.halfReleased).toContain("CHECK constraint failed");
  });

  it("leaves existing sessions unarchived and refuses an archived_at without an archived_by", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* insertWorkspaceWithSessions;
        yield* runMigrations(UP_TO_ARCHIVED_SESSIONS);
        const sessions =
          yield* sql`SELECT id, done_at, done_by, archived_at, archived_by FROM sessions ORDER BY id`;
        const onlyAt = yield* Effect.flip(
          sql`UPDATE sessions SET archived_at = 't9' WHERE id = 'open'`,
        );
        const onlyBy = yield* Effect.flip(
          sql`UPDATE sessions SET archived_by = 'user' WHERE id = 'open'`,
        );
        yield* sql`UPDATE sessions SET archived_at = 't9', archived_by = 'user' WHERE id = 'done'`;
        const archived =
          yield* sql`SELECT archived_at, archived_by FROM sessions WHERE id = 'done'`;
        return {
          sessions,
          onlyAt: String(onlyAt.cause.cause),
          onlyBy: String(onlyBy.cause.cause),
          archived,
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(result.sessions).toEqual([
      { id: "done", done_at: "finished", done_by: "user", archived_at: null, archived_by: null },
      { id: "open", done_at: null, done_by: null, archived_at: null, archived_by: null },
    ]);
    expect(result.onlyAt).toContain("CHECK constraint failed");
    expect(result.onlyBy).toContain("CHECK constraint failed");
    expect(result.archived).toEqual([{ archived_at: "t9", archived_by: "user" }]);
  });
});
