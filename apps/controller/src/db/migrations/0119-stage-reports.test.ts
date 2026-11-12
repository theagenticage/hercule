/**
 * Tests what the stage reports migration does to a database at the previous
 * head: each live Task gets its oldest Thread as lead, whatever that Thread's
 * state, and sessions of other kinds never lead.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../migrate";
import { TestDatabaseWriter } from "../testing";
import { migrations } from "./index";

const BEFORE = migrations.filter(([id]) => id < 119);
const UP_TO_STAGE_REPORTS = migrations.filter(([id]) => id <= 119);

/** Builds the 16 bytes of a test id. */
const buildTestId = (name: string): Uint8Array => {
  const bytes = new Uint8Array(16);
  new TextEncoder().encodeInto(name, bytes);
  return bytes;
};

const AT = "2026-11-01T00:00:00.000Z";

const insertTask = (sql: SqlClient.SqlClient, name: string, deletedAt: string | null = null) =>
  sql`INSERT INTO tasks (id, title, description, status, stage, priority, labels, board_rank,
                         created_at, updated_at, status_changed_at, stage_changed_at, deleted_at)
      VALUES (${buildTestId(name)}, ${name}, '', 'open', 'planned', 'normal', '[]', 'M',
              ${AT}, ${AT}, ${AT}, ${AT}, ${deletedAt})`;

/**
 * Inserts a session of the given kind. `kind` is generated from the other
 * columns: no agent is a Thread, an agent with a run is a run session, and an
 * agent alone is an Agent session.
 */
const insertSession = (
  sql: SqlClient.SqlClient,
  name: string,
  task: string,
  kind: "thread" | "agent" | "run",
  createdAt: string,
  archivedAt: string | null = null,
) =>
  sql`INSERT INTO sessions (id, permission_profile_id, provider_account_id, runner_id, agent_id, run_id,
                            requested_access_mode, access_mode, spec, title, status, task_id,
                            created_at, last_activity_at, archived_at, archived_by)
      VALUES (${buildTestId(name)}, ${buildTestId("profile")}, ${buildTestId("provider")}, ${buildTestId("runner")},
              ${kind === "thread" ? null : buildTestId("agent")},
              ${kind === "run" ? buildTestId("run") : null},
              'default', 'default', '{}', ${name}, 'exited', ${buildTestId(task)},
              ${createdAt}, ${createdAt}, ${archivedAt}, ${archivedAt === null ? null : "user"})`;

describe("the stage reports migration", () => {
  it("makes the oldest Thread the lead, archived ones included, and ignores other kinds", async () => {
    const leads = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`INSERT INTO runs (id, plan, inputs, origin, status, created_at)
                   VALUES (${buildTestId("run")}, '{}', '{}', '{}', 'pending', ${AT})`;
        for (const task of ["two-threads", "runs-only", "agent-first", "deleted"]) {
          yield* insertTask(sql, task, task === "deleted" ? AT : null);
        }
        yield* insertSession(sql, "newer", "two-threads", "thread", "2026-11-03T00:00:00.000Z");
        yield* insertSession(sql, "older", "two-threads", "thread", "2026-11-02T00:00:00.000Z", AT);
        yield* insertSession(sql, "run", "runs-only", "run", "2026-11-02T00:00:00.000Z");
        yield* insertSession(sql, "agent", "agent-first", "agent", "2026-11-01T00:00:00.000Z");
        yield* insertSession(sql, "thread", "agent-first", "thread", "2026-11-02T00:00:00.000Z");
        yield* insertSession(sql, "gone", "deleted", "thread", "2026-11-02T00:00:00.000Z");
        yield* runMigrations(UP_TO_STAGE_REPORTS);
        return yield* sql<{ readonly title: string; readonly lead_session_id: Uint8Array | null }>`
          SELECT title, lead_session_id FROM tasks ORDER BY title`;
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    const decode = (id: Uint8Array | null) =>
      id === null ? null : new TextDecoder().decode(id).replace(/\0+$/, "");
    expect(leads.map((row) => [row.title, decode(row.lead_session_id)])).toEqual([
      ["agent-first", "thread"],
      ["deleted", null],
      ["runs-only", null],
      ["two-threads", "older"],
    ]);
  });

  it("starts every Task with no stage cause session and holds one report per Task", async () => {
    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_STAGE_REPORTS);
        yield* insertTask(sql, "task");
        const report = Effect.exit(
          sql`INSERT INTO task_stage_reports (task_id, session_id, stage, reported_at)
              VALUES (${buildTestId("task")}, ${buildTestId("session")}, 'review', ${AT})`,
        );
        const causes = yield* sql<{ readonly stage_cause_session_id: Uint8Array | null }>`
          SELECT stage_cause_session_id FROM tasks`;
        return { causes, reports: [(yield* report)._tag, (yield* report)._tag] };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(outcomes).toEqual({
      causes: [{ stage_cause_session_id: null }],
      reports: ["Success", "Failure"],
    });
  });
});
