/**
 * Tests what the events runner id migration does to a database at the
 * previous head: each audit entry kind that shows a machine's activity gets
 * the runner its payload names, directly or through its workspace or session,
 * and every other entry keeps no runner.
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

const BEFORE = migrations.filter(([id]) => id < 105);
const UP_TO_EVENTS_RUNNER_ID = migrations.filter(([id]) => id <= 105);

const NOW = "2026-11-01T00:00:00.000Z";

const RUNNER_A = "0199e0e7-7b21-7000-8000-00000000000a";
const RUNNER_B = "0199e0e7-7b21-7000-8000-00000000000b";
const WORKSPACE_ON_A = "0199e0e7-7b21-7000-8000-0000000000a1";
const SESSION_ON_B = "0199e0e7-7b21-7000-8000-0000000000b1";
const UNKNOWN = "0199e0e7-7b21-7000-8000-0000000000ff";

/** The id as the 16 bytes a table stores, written as SQL that converts the canonical string. */
const bytesOf = (id: string) => id.replaceAll("-", "");

/** The 19 kinds the migration fills, as the spec lists them. */
const FILLED_KINDS = [
  "runner.joined",
  "runner.stateChanged",
  "runner.updated",
  "runner.drained",
  "runner.undrained",
  "runner.placementsChanged",
  "runner.crashLooping",
  "runner.retired",
  "workspace.created",
  "workspace.disposalRequested",
  "workspace.disposalRefused",
  "workspace.deleted",
  "workspace.detached",
  "workspace.attachmentRetried",
  "session.spawned",
  "session.stopped",
  "session.reconciled",
  "session.archived",
  "providerAccount.signedIn",
];

/** Writes two runners, a workspace on the first and a session on the second, as the previous head stores them. */
const insertSubjects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels, credential_hash, created_at, updated_at)
             VALUES (unhex(${bytesOf(RUNNER_A)}), 'a', 'online', 'active', 0, '{}', 'hash-a', ${NOW}, ${NOW}),
                    (unhex(${bytesOf(RUNNER_B)}), 'b', 'online', 'active', 0, '{}', 'hash-b', ${NOW}, ${NOW})`;
  yield* sql`INSERT INTO workspaces (id, runner_id, kind, status, created_at, ownership, warnings)
             VALUES (unhex(${bytesOf(WORKSPACE_ON_A)}), unhex(${bytesOf(RUNNER_A)}), 'ephemeral', 'ready', ${NOW}, 'managed', '[]')`;
  yield* sql`INSERT INTO sessions (id, permission_profile_id, provider_account_id, runner_id, workspace_id, requested_access_mode, access_mode, spec, title, status, created_at, last_activity_at)
             VALUES (unhex(${bytesOf(SESSION_ON_B)}), 'profile', 'provider', unhex(${bytesOf(RUNNER_B)}), unhex(${bytesOf(WORKSPACE_ON_A)}), 'default', 'default', '{}', 'thread', 'exited', ${NOW}, ${NOW})`;
});

/** Appends one event of the previous head with this kind and payload, and returns its id. */
const insertEvent = (kind: string, payload: unknown, dedupKey: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly id: number }>`
      INSERT INTO events (source, system, kind, occurred_at, received_at, dedup_key, payload)
      VALUES ('hercule', 'hercule', ${kind}, ${NOW}, ${NOW}, ${dedupKey}, ${JSON.stringify(payload)})
      RETURNING id`;
    return row!.id;
  });

/** Reads the runner of each event as a canonical id string, or null, keyed by event id. */
const readRunners = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly id: number; readonly runner: string | null }>`
    SELECT id, CASE WHEN runner_id IS NULL THEN NULL ELSE lower(hex(runner_id)) END AS runner FROM events`;
  return new Map(
    rows.map((row) => [
      row.id,
      row.runner === null
        ? null
        : `${row.runner.slice(0, 8)}-${row.runner.slice(8, 12)}-${row.runner.slice(12, 16)}-${row.runner.slice(16, 20)}-${row.runner.slice(20)}`,
    ]),
  );
});

describe("the events runner id migration", () => {
  it("fills each kind from the payload's runner, then its workspace's, then its session's", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* runMigrations(BEFORE);
        yield* insertSubjects;
        const fromRunner = yield* insertEvent("runner.updated", { runnerId: RUNNER_A }, "runner");
        const fromWorkspace = yield* insertEvent(
          "workspace.created",
          { workspaceId: WORKSPACE_ON_A },
          "workspace",
        );
        const fromSession = yield* insertEvent(
          "session.archived",
          { sessionId: SESSION_ON_B, threadId: "t" },
          "session",
        );
        yield* runMigrations(UP_TO_EVENTS_RUNNER_ID);
        const runners = yield* readRunners;
        return {
          fromRunner: runners.get(fromRunner),
          fromWorkspace: runners.get(fromWorkspace),
          fromSession: runners.get(fromSession),
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(result).toEqual({
      fromRunner: RUNNER_A,
      fromWorkspace: RUNNER_A,
      fromSession: RUNNER_B,
    });
  });

  it("fills every one of the 19 kinds and no other", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* insertSubjects;
        for (const kind of FILLED_KINDS) {
          yield* insertEvent(kind, { runnerId: RUNNER_A }, kind);
        }
        yield* insertEvent("workspace.observed", { runnerId: RUNNER_A }, "observed");
        yield* insertEvent("runner.joinToken.created", { runnerId: RUNNER_A }, "join-token");
        yield* runMigrations(UP_TO_EVENTS_RUNNER_ID);
        return yield* sql<{ readonly kind: string; readonly filled: number }>`
          SELECT kind, runner_id IS NOT NULL AS filled FROM events ORDER BY id`;
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(result.filter((row) => row.filled === 1).map((row) => row.kind)).toEqual(FILLED_KINDS);
    expect(result.filter((row) => row.filled === 0).map((row) => row.kind)).toEqual([
      "workspace.observed",
      "runner.joinToken.created",
    ]);
  });

  it("prefers the payload's runner over the runner of its workspace or session", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* runMigrations(BEFORE);
        yield* insertSubjects;
        const bothNamed = yield* insertEvent(
          "session.stopped",
          { sessionId: SESSION_ON_B, workspaceId: WORKSPACE_ON_A, runnerId: RUNNER_B },
          "runner-over-both",
        );
        const workspaceOverSession = yield* insertEvent(
          "session.stopped",
          { sessionId: SESSION_ON_B, workspaceId: WORKSPACE_ON_A, reason: "workspace_failed" },
          "workspace-over-session",
        );
        yield* runMigrations(UP_TO_EVENTS_RUNNER_ID);
        const runners = yield* readRunners;
        return {
          bothNamed: runners.get(bothNamed),
          workspaceOverSession: runners.get(workspaceOverSession),
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(result).toEqual({ bothNamed: RUNNER_B, workspaceOverSession: RUNNER_A });
  });

  it("keeps a payload runner that no table knows, and leaves an entry with no known subject empty", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* runMigrations(BEFORE);
        yield* insertSubjects;
        const goneRunner = yield* insertEvent(
          "runner.retired",
          { runnerId: UNKNOWN },
          "gone-runner",
        );
        const unknownWorkspace = yield* insertEvent(
          "workspace.deleted",
          { workspaceId: UNKNOWN },
          "unknown-workspace",
        );
        const unknownSession = yield* insertEvent(
          "session.reconciled",
          { sessionId: UNKNOWN },
          "unknown-session",
        );
        const unknownWorkspaceKnownSession = yield* insertEvent(
          "session.stopped",
          { workspaceId: UNKNOWN, sessionId: SESSION_ON_B },
          "unknown-workspace-known-session",
        );
        const nothingNamed = yield* insertEvent("runner.crashLooping", { count: 3 }, "nothing");
        const notAnId = yield* insertEvent(
          "runner.updated",
          { runnerId: "laptop", workspaceId: 7 },
          "not-an-id",
        );
        yield* runMigrations(UP_TO_EVENTS_RUNNER_ID);
        const runners = yield* readRunners;
        return {
          goneRunner: runners.get(goneRunner),
          unknownWorkspace: runners.get(unknownWorkspace),
          unknownSession: runners.get(unknownSession),
          unknownWorkspaceKnownSession: runners.get(unknownWorkspaceKnownSession),
          nothingNamed: runners.get(nothingNamed),
          notAnId: runners.get(notAnId),
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(result).toEqual({
      goneRunner: UNKNOWN,
      unknownWorkspace: null,
      unknownSession: null,
      unknownWorkspaceKnownSession: RUNNER_B,
      nothingNamed: null,
      notAnId: null,
    });
  });

  it("indexes the filled entries by runner and event id, and only those", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* insertSubjects;
        yield* insertEvent("runner.updated", { runnerId: RUNNER_A }, "filled");
        yield* insertEvent("workspace.observed", { runnerId: RUNNER_A }, "observed");
        yield* runMigrations(UP_TO_EVENTS_RUNNER_ID);
        const index = yield* sql<{ readonly sql: string }>`
          SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'events_runner_id'`;
        const plan = yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT id FROM events WHERE runner_id = unhex(${bytesOf(RUNNER_A)}) ORDER BY id DESC`;
        return { index, plan };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(result.index).toHaveLength(1);
    expect(result.index[0]!.sql).toContain("WHERE runner_id IS NOT NULL");
    expect(result.plan.map((row) => row.detail).join("\n")).toContain("INDEX events_runner_id");
  });
});
