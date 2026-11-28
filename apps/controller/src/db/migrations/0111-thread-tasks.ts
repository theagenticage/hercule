/**
 * Gives a session a Task, and gives the Threads that are open now their Tasks
 * (spec 09).
 *
 * - `sessions.task_id` is the Task a session belongs to. It is not a foreign
 *   key, like `runs.task_id`: the tasks domain owns the table, and a session
 *   is history that keeps the id of a Task deleted since. The partial index
 *   serves the session list filtered by Task, newest first.
 * - `task_workspaces` remembers which Task an ephemeral workspace belongs to,
 *   so the next Thread started in that workspace joins the same Task. It holds
 *   plain ids: neither column is a foreign key.
 *
 * The backfill reads the unfinished Threads first, then writes. A Thread is
 * unfinished when it is neither Done nor archived. Threads that share an
 * ephemeral workspace share one new Task. A Thread in a main workspace, with
 * no workspace, or whose workspace row is gone gets a Task of its own, because
 * sharing a main workspace says nothing about being the same work. Each
 * new Task:
 *
 * - takes its title, project, `created_at` and `updated_at` from the oldest
 *   Thread of the group, oldest by `(created_at, id)`;
 * - has stage `exploring`, status `open` and priority `normal`;
 * - has no project when the Thread's project is soft-deleted or gone.
 *
 * Which Tasks and groups the backfill makes is the same on every run. The
 * Task ids are not: each one is minted when the migration runs.
 *
 * In an ephemeral workspace, the Task also goes to the workspace's Agent
 * sessions that are not archived, and the workspace gets a `task_workspaces`
 * row dated by the oldest Thread. A session that runs a workflow step takes the
 * Task of its run, when the run has one. Done and archived Threads stay
 * without a Task: reopening one joins a Task by the same rules as a new Thread.
 *
 * The migration writes no event, no audit row and no provenance entry, so no
 * workflow starts for an old Thread. It does not change `last_activity_at`.
 * The tasks table's own trigger indexes each new Task for full-text search.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { mintUuid } from "../id";

/** The longest Task title; see `MAX_TASK_TITLE_LENGTH` in the contract. */
const MAX_TITLE_LENGTH = 512;

/** The title of a Task whose Thread has none; a Task title cannot be empty. */
const BLANK_TITLE = "Untitled thread";

interface UnfinishedThread {
  readonly id: Uint8Array;
  readonly title: string;
  readonly created_at: string;
  readonly workspace_id: Uint8Array | null;
  readonly workspace_kind: string | null;
  /** The Thread's project when it exists and is not deleted, else `null`. */
  readonly live_project_id: Uint8Array | null;
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE sessions ADD COLUMN task_id BLOB`;
  yield* sql`
    CREATE INDEX sessions_task_id ON sessions (task_id, created_at, id) WHERE task_id IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE task_workspaces (
      workspace_id BLOB PRIMARY KEY NOT NULL,
      task_id BLOB NOT NULL,
      joined_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;

  const threads = yield* sql<UnfinishedThread>`
    SELECT s.id, s.title, s.created_at, s.workspace_id, w.kind AS workspace_kind,
           p.id AS live_project_id
    FROM sessions s
    LEFT JOIN workspaces w ON w.id = s.workspace_id
    LEFT JOIN projects p ON p.id = s.project_id AND p.deleted_at IS NULL
    WHERE s.kind = 'thread' AND s.done_at IS NULL AND s.archived_at IS NULL
    ORDER BY s.created_at, s.id
  `;

  // The oldest Thread of each group comes first, because the rows are sorted
  // and a Map keeps the order its keys were added in.
  const groups = new Map<string, Array<UnfinishedThread>>();
  for (const thread of threads) {
    const key =
      thread.workspace_kind === "ephemeral" && thread.workspace_id !== null
        ? `workspace:${Buffer.from(thread.workspace_id).toString("hex")}`
        : `thread:${Buffer.from(thread.id).toString("hex")}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [thread]);
    else group.push(thread);
  }

  for (const group of groups.values()) {
    const oldest = group[0]!;
    const taskId = mintUuid();
    const title =
      oldest.title.trim() === "" ? BLANK_TITLE : oldest.title.slice(0, MAX_TITLE_LENGTH);
    yield* sql`
      INSERT INTO tasks (id, title, description, status, stage, priority, labels, project_id,
                         created_at, updated_at, status_changed_at, stage_changed_at)
      VALUES (${taskId}, ${title}, '', 'open', 'exploring', 'normal', '[]', ${oldest.live_project_id},
              ${oldest.created_at}, ${oldest.created_at}, ${oldest.created_at}, ${oldest.created_at})
    `;
    if (oldest.workspace_kind === "ephemeral" && oldest.workspace_id !== null) {
      yield* sql`
        INSERT INTO task_workspaces (workspace_id, task_id, joined_at)
        VALUES (${oldest.workspace_id}, ${taskId}, ${oldest.created_at})
      `;
      // The predicate repeats the one that built the groups, so a Done Thread
      // and an archived session in the same workspace stay without a Task, and
      // a workflow step's session is left to the statement below.
      yield* sql`
        UPDATE sessions SET task_id = ${taskId}
        WHERE workspace_id = ${oldest.workspace_id}
          AND ((kind = 'thread' AND done_at IS NULL AND archived_at IS NULL)
            OR (kind = 'agent' AND archived_at IS NULL))
      `;
    } else {
      yield* sql`UPDATE sessions SET task_id = ${taskId} WHERE id = ${oldest.id}`;
    }
  }

  yield* sql`
    UPDATE sessions
    SET task_id = (SELECT runs.task_id FROM runs WHERE runs.id = sessions.run_id)
    WHERE kind = 'run'
      AND run_id IN (SELECT id FROM runs WHERE task_id IS NOT NULL)
  `;
});
