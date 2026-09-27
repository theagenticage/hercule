/**
 * Tests what the workspace leases migration does to a database at the
 * previous head: every session and run with a workspace gets the lease the
 * sweep's old rules amount to, `runs.keep_workspace` is dropped, and a stored
 * `workspace.failedRunTtlDays` moves to `workspace.inspectionTtlDays`.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 34);

const created = "2026-09-01T00:00:00.000Z";
const ended = "2026-09-02T10:00:00.000Z";

/** A session to seed, named by what the test expects of its lease. */
interface SeededSession {
  readonly name: string;
  readonly status: "busy" | "exited";
  readonly nativeSessionId: string | null;
  /** One of the seeded workspaces: `ephemeral`, `primary` or `gone`; `null` for none. */
  readonly workspace: "ephemeral" | "primary" | "gone" | null;
}

/** A run to seed, named by what the test expects of its lease. */
interface SeededRun {
  readonly name: string;
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly keepWorkspace: boolean;
}

/** A lease after the migration, with its holder named as it was seeded. */
interface LeaseRow {
  readonly holder: string;
  readonly holder_kind: string;
  readonly acquired_at: string;
  readonly released_at: string | null;
  readonly retention: string | null;
  readonly kept_until: string | null;
}

/**
 * Seeds one online runner with three workspaces, then the sessions and runs,
 * runs the migration, and returns every lease by holder name and the
 * columns `runs` has afterwards. The workspaces are a ready ephemeral one,
 * which every run works in, a ready primary, and a deleted ephemeral one.
 */
const seedAndMigrate = (seeded: {
  readonly sessions: ReadonlyArray<SeededSession>;
  readonly runs: ReadonlyArray<SeededRun>;
}): Promise<{
  readonly leases: ReadonlyMap<string, LeaseRow>;
  readonly runColumns: ReadonlyArray<string>;
}> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations(BEFORE);
      yield* sql`
        INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels,
                             credential_hash, created_at, updated_at)
        VALUES ('runner', 'laptop', 'online', 'active', 0, '{}', 'hash', ${created}, ${created})`;
      yield* sql`
        INSERT INTO workspaces (id, runner_id, kind, status, created_at)
        VALUES ('ephemeral', 'runner', 'ephemeral', 'ready', ${created}),
               ('primary', 'runner', 'primary', 'ready', ${created}),
               ('gone', 'runner', 'ephemeral', 'deleted', ${created})`;
      yield* Effect.forEach(
        seeded.sessions,
        (session) => sql`
          INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id, workspace_id,
                                requested_access_mode, access_mode, spec, title,
                                native_session_id, status, created_at, exited_at,
                                last_activity_at)
          VALUES (${session.name}, 'profile', 'instance', 'runner',
                  ${session.workspace}, 'full-access', 'full-access',
                  '{}', 'title', ${session.nativeSessionId}, ${session.status}, ${created},
                  ${session.status === "exited" ? ended : null}, ${created})`,
        { discard: true },
      );
      yield* Effect.forEach(
        seeded.runs,
        (run) => sql`
          INSERT INTO runs (id, plan, inputs, origin, status, failure_reason, created_at,
                            started_at, finished_at, workspace_id, keep_workspace)
          VALUES (${run.name}, '{}', '{}', '{}', ${run.status},
                  ${run.status === "failed" ? "boom" : null}, ${created}, ${created},
                  ${run.status === "running" ? null : ended}, 'ephemeral',
                  ${run.keepWorkspace ? 1 : 0})`,
        { discard: true },
      );
      yield* runMigrations();
      const leases = yield* sql<LeaseRow>`
        SELECT CAST(holder_id AS TEXT) AS holder, holder_kind, acquired_at, released_at,
               retention, kept_until
        FROM workspace_leases`;
      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('runs')`;
      return {
        leases: new Map(leases.map((lease) => [lease.holder, lease])),
        runColumns: columns.map((column) => column.name),
      };
    }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
  );

describe("the workspace leases migration", () => {
  it("gives each session with a workspace a lease: active while it runs, idle or orphan after it exited", async () => {
    const { leases } = await seedAndMigrate({
      sessions: [
        { name: "running", status: "busy", nativeSessionId: null, workspace: "ephemeral" },
        { name: "resumable", status: "exited", nativeSessionId: "native", workspace: "ephemeral" },
        { name: "orphaned", status: "exited", nativeSessionId: null, workspace: "ephemeral" },
        { name: "no workspace", status: "exited", nativeSessionId: null, workspace: null },
      ],
      runs: [],
    });

    expect(leases.get("running")).toEqual({
      holder: "running",
      holder_kind: "session",
      acquired_at: created,
      released_at: null,
      retention: null,
      kept_until: null,
    });
    expect(leases.get("resumable")).toMatchObject({
      released_at: ended,
      retention: "idle",
      kept_until: "2026-10-02T10:00:00.000Z",
    });
    expect(leases.get("orphaned")).toMatchObject({
      released_at: ended,
      retention: "orphan",
      kept_until: "2026-09-03T10:00:00.000Z",
    });
    expect(leases.has("no workspace")).toBe(false);
  });

  it("gives each run with a workspace a lease: active while it runs, inspection or none after it ended", async () => {
    const { leases } = await seedAndMigrate({
      sessions: [],
      runs: [
        { name: "running", status: "running", keepWorkspace: false },
        { name: "completed", status: "completed", keepWorkspace: false },
        { name: "failed", status: "failed", keepWorkspace: false },
        { name: "cancelled", status: "cancelled", keepWorkspace: false },
        { name: "cancelled and kept", status: "cancelled", keepWorkspace: true },
      ],
    });

    expect(leases.get("running")).toMatchObject({
      holder_kind: "run",
      released_at: null,
      retention: null,
      kept_until: null,
    });
    const inspection = {
      released_at: ended,
      retention: "inspection",
      kept_until: "2026-09-16T10:00:00.000Z",
    };
    const none = { released_at: ended, retention: "none", kept_until: ended };
    expect(leases.get("completed")).toMatchObject(none);
    expect(leases.get("failed")).toMatchObject(inspection);
    expect(leases.get("cancelled")).toMatchObject(none);
    expect(leases.get("cancelled and kept")).toMatchObject(inspection);
  });

  it("keeps a released lease only on an ephemeral workspace that is not gone", async () => {
    const { leases } = await seedAndMigrate({
      sessions: [
        { name: "in primary", status: "busy", nativeSessionId: null, workspace: "primary" },
        { name: "left primary", status: "exited", nativeSessionId: null, workspace: "primary" },
        { name: "left gone", status: "exited", nativeSessionId: null, workspace: "gone" },
      ],
      runs: [],
    });

    expect([...leases.keys()]).toEqual(["in primary"]);
  });

  it("drops runs.keep_workspace", async () => {
    const { runColumns } = await seedAndMigrate({ sessions: [], runs: [] });

    expect(runColumns).not.toContain("keep_workspace");
    expect(runColumns).toContain("workspace_id");
  });

  it("moves a stored workspace.failedRunTtlDays to workspace.inspectionTtlDays", async () => {
    const keys = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`
          INSERT INTO settings (scope, key, value, updated_at)
          VALUES ('controller', 'workspace.failedRunTtlDays', '7', ${created})`;
        yield* runMigrations();
        return yield* sql<{ readonly key: string; readonly value: string }>`
          SELECT key, value FROM settings WHERE key LIKE 'workspace.%'`;
      }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
    );

    expect(keys).toEqual([{ key: "workspace.inspectionTtlDays", value: "7" }]);
  });
});
