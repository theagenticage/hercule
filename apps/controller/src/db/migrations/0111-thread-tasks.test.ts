/**
 * Tests what the thread tasks migration does to a database at the previous
 * head: which unfinished Threads get a Task and which share one, what the new
 * Tasks hold, and which sessions are left alone. The upgrade test in `e2e/`
 * owns the migration of data written by a real binary; these tests check the
 * row shapes.
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

const BEFORE = migrations.filter(([id]) => id < 111);
const UP_TO_THREAD_TASKS = migrations.filter(([id]) => id <= 111);

/** Builds the 16 bytes of a test id, so the id shows in the order of the sorted rows. */
const idOf = (name: string): Uint8Array => {
  const bytes = new Uint8Array(16);
  new TextEncoder().encodeInto(name, bytes);
  return bytes;
};

const at = (minute: number): string => `2026-11-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

interface SessionRow {
  readonly name: string;
  readonly title?: string;
  readonly minute: number;
  readonly workspace?: string;
  readonly project?: string;
  readonly agent?: boolean;
  readonly run?: string;
  readonly done?: boolean;
  readonly archived?: boolean;
}

const SESSIONS: ReadonlyArray<SessionRow> = [
  // Two unfinished Threads in one ephemeral workspace: one Task, from the older.
  { name: "shared-newer", title: "Second", minute: 12, workspace: "ephemeral" },
  { name: "shared-older", title: "First", minute: 11, workspace: "ephemeral", project: "live" },
  // Finished work in the same workspace stays without a Task.
  { name: "shared-done", minute: 13, workspace: "ephemeral", done: true },
  { name: "shared-archived", minute: 14, workspace: "ephemeral", archived: true },
  // Agent sessions: only the one that is not archived joins.
  { name: "agent-live", minute: 15, workspace: "ephemeral", agent: true },
  { name: "agent-archived", minute: 16, workspace: "ephemeral", agent: true, archived: true },
  // Workflow step sessions take the Task of their run, never the workspace's.
  { name: "step-on-task", minute: 17, workspace: "ephemeral", agent: true, run: "run-on-task" },
  { name: "step-no-task", minute: 18, workspace: "ephemeral", agent: true, run: "run-no-task" },
  // Each of these gets a Task of its own.
  { name: "main", title: "In main", minute: 20, workspace: "primary", project: "deleted" },
  { name: "alone", title: "Alone", minute: 21 },
  { name: "orphan", title: "Orphan", minute: 22, workspace: "gone" },
  { name: "blank", title: "   ", minute: 23 },
  { name: "long", title: "x".repeat(600), minute: 24 },
];

/** Writes what the previous head stores: a runner, workspaces, projects, runs and the sessions above. */
const insertRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels, credential_hash, created_at, updated_at)
             VALUES (${idOf("runner")}, 'one', 'online', 'active', 0, '[]', 'hash', ${at(0)}, ${at(0)})`;
  yield* sql`INSERT INTO workspaces (id, runner_id, kind, status, created_at, ownership, warnings)
             VALUES (${idOf("ephemeral")}, ${idOf("runner")}, 'ephemeral', 'ready', ${at(0)}, 'managed', '[]'),
                    (${idOf("primary")}, ${idOf("runner")}, 'primary', 'ready', ${at(0)}, 'managed', '[]')`;
  yield* sql`INSERT INTO projects (id, name, created_at, updated_at, deleted_at)
             VALUES (${idOf("live")}, 'Live', ${at(0)}, ${at(0)}, NULL),
                    (${idOf("deleted")}, 'Deleted', ${at(0)}, ${at(0)}, ${at(1)})`;
  yield* sql`INSERT INTO tasks (id, title, description, status, priority, labels, created_at, updated_at, status_changed_at)
             VALUES (${idOf("task-of-run")}, 'Existing', '', 'open', 'normal', '[]', ${at(0)}, ${at(0)}, ${at(0)})`;
  yield* sql`INSERT INTO runs (id, plan, inputs, origin, status, created_at, task_id)
             VALUES (${idOf("run-on-task")}, '{}', '{}', '{}', 'pending', ${at(0)}, ${idOf("task-of-run")}),
                    (${idOf("run-no-task")}, '{}', '{}', '{}', 'pending', ${at(0)}, NULL)`;
  for (const session of SESSIONS) {
    yield* sql`INSERT INTO sessions (id, permission_profile_id, provider_account_id, runner_id, workspace_id,
                                     project_id, agent_id, run_id, requested_access_mode, access_mode, spec,
                                     title, status, created_at, last_activity_at, done_at, done_by, archived_at, archived_by)
               VALUES (${idOf(session.name)}, ${idOf("profile")}, ${idOf("provider")}, ${idOf("runner")},
                       ${session.workspace === undefined ? null : idOf(session.workspace)},
                       ${session.project === undefined ? null : idOf(session.project)},
                       ${session.agent === true ? idOf("agent") : null},
                       ${session.run === undefined ? null : idOf(session.run)},
                       'default', 'default', '{}', ${session.title ?? session.name}, 'exited',
                       ${at(session.minute)}, ${at(session.minute)},
                       ${session.done === true ? at(30) : null},
                       ${session.done === true ? "user" : null},
                       ${session.archived === true ? at(30) : null},
                       ${session.archived === true ? "user" : null})`;
  }
});

const decodeName = (bytes: Uint8Array | null): string | null =>
  bytes === null ? null : new TextDecoder().decode(bytes).replaceAll("\0", "");

describe("the thread tasks migration", () => {
  it("gives each group of unfinished Threads one Task and leaves finished sessions alone", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* insertRows;
        const activityBefore = yield* sql`SELECT id, last_activity_at FROM sessions ORDER BY id`;
        yield* runMigrations(UP_TO_THREAD_TASKS);
        const sessions = yield* sql<{
          readonly id: Uint8Array;
          readonly task_id: Uint8Array | null;
        }>`
          SELECT id, task_id FROM sessions ORDER BY created_at`;
        const activityAfter = yield* sql`SELECT id, last_activity_at FROM sessions ORDER BY id`;
        const tasks = yield* sql<{
          readonly id: Uint8Array;
          readonly title: string;
          readonly description: string;
          readonly status: string;
          readonly stage: string;
          readonly priority: string;
          readonly labels: string;
          readonly project_id: Uint8Array | null;
          readonly created_at: string;
          readonly updated_at: string;
          readonly status_changed_at: string;
          readonly stage_changed_at: string;
          readonly deleted_at: string | null;
        }>`SELECT * FROM tasks WHERE id <> ${idOf("task-of-run")} ORDER BY created_at`;
        const workspaces = yield* sql<{
          readonly workspace_id: Uint8Array;
          readonly task_id: Uint8Array;
          readonly joined_at: string;
        }>`SELECT * FROM task_workspaces`;
        const found = yield* sql<{ readonly title: string }>`
          SELECT tasks.title FROM tasks_fts JOIN tasks ON tasks.rowid = tasks_fts.rowid
          WHERE tasks_fts MATCH 'Alone'`;
        const events = yield* sql<{ readonly total: number }>`SELECT count(*) AS total FROM events`;
        return { sessions, activityBefore, activityAfter, tasks, workspaces, found, events };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    const taskOf = new Map(
      result.sessions.map((session) => [
        decodeName(session.id)!,
        session.task_id === null ? null : Buffer.from(session.task_id).toString("hex"),
      ]),
    );
    const sharedTask = taskOf.get("shared-older")!;
    expect(sharedTask).not.toBeNull();
    expect(taskOf.get("shared-newer")).toBe(sharedTask);
    expect(taskOf.get("agent-live")).toBe(sharedTask);
    for (const name of ["shared-done", "shared-archived", "agent-archived", "step-no-task"]) {
      expect(taskOf.get(name), name).toBeNull();
    }
    expect(taskOf.get("step-on-task")).toBe(Buffer.from(idOf("task-of-run")).toString("hex"));
    const ownTasks = ["main", "alone", "orphan", "blank", "long"].map((name) => taskOf.get(name));
    expect(new Set([sharedTask, ...ownTasks]).size).toBe(6);
    expect(ownTasks).not.toContain(null);

    expect(
      result.tasks.map((task) => ({
        title: task.title.slice(0, 20),
        length: task.title.length,
        project: decodeName(task.project_id),
        createdAt: task.created_at,
        updatedAt: task.updated_at,
        statusChangedAt: task.status_changed_at,
        stageChangedAt: task.stage_changed_at,
        shape: [task.description, task.status, task.stage, task.priority, task.labels],
        deletedAt: task.deleted_at,
      })),
    ).toEqual(
      [
        { title: "First", length: 5, project: "live", minute: 11 },
        { title: "In main", length: 7, project: null, minute: 20 },
        { title: "Alone", length: 5, project: null, minute: 21 },
        { title: "Orphan", length: 6, project: null, minute: 22 },
        { title: "Untitled thread", length: 15, project: null, minute: 23 },
        { title: "x".repeat(20), length: 512, project: null, minute: 24 },
      ].map(({ minute, ...task }) => ({
        ...task,
        createdAt: at(minute),
        updatedAt: at(minute),
        statusChangedAt: at(minute),
        stageChangedAt: at(minute),
        shape: ["", "open", "exploring", "normal", "[]"],
        deletedAt: null,
      })),
    );

    expect(result.workspaces).toHaveLength(1);
    expect(decodeName(result.workspaces[0]!.workspace_id)).toBe("ephemeral");
    expect(Buffer.from(result.workspaces[0]!.task_id).toString("hex")).toBe(sharedTask);
    expect(result.workspaces[0]!.joined_at).toBe(at(11));

    expect(result.activityAfter).toEqual(result.activityBefore);
    expect(result.events).toEqual([{ total: 0 }]);
    expect(result.found).toEqual([{ title: "Alone" }]);
  });

  it("serves a session list by Task from the partial index", async () => {
    const plan = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_THREAD_TASKS);
        return yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT id FROM sessions WHERE task_id = ${idOf("task")}
          ORDER BY created_at DESC, id DESC LIMIT 51`;
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    const details = plan.map((row) => row.detail).join("\n");
    expect(details).toContain("sessions_task_id");
    expect(details).not.toContain("TEMP B-TREE");
  });
});
