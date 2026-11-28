/**
 * Adds the lead Thread of a Task and the Stage Report it files.
 *
 * - `tasks.lead_session_id` is the Thread that leads the Task: the one session
 *   that reports its stage. It is null when no Thread is on the Task. It is not
 *   a foreign key, like `sessions.task_id`: a session is history.
 * - `tasks.stage_cause_session_id` is the session whose Stage Report placed the
 *   Task's current stage. It is null when a person, the status or a fact placed
 *   it. It sits beside `stage_cause_fact_id`.
 * - `task_stage_reports` has one row per Task: the lead's last claim about the
 *   stage, with the session that made it and when.
 *
 * The backfill gives every Task that is not deleted the oldest Thread on it as
 * its lead, oldest by `(created_at, id)`. A Done or archived Thread counts.
 * Sessions of kind `agent`, `run` and `assistant` never lead. A Task with no
 * Thread keeps a null lead. It is plain SQL on the stored ids, so it works on
 * whatever type the ids have.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE tasks ADD COLUMN lead_session_id BLOB`;
  yield* sql`ALTER TABLE tasks ADD COLUMN stage_cause_session_id BLOB`;

  yield* sql`
    CREATE TABLE task_stage_reports (
      task_id BLOB PRIMARY KEY NOT NULL REFERENCES tasks (id),
      session_id BLOB NOT NULL,
      stage TEXT NOT NULL,
      reported_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;

  yield* sql`
    UPDATE tasks
    SET lead_session_id = (
      SELECT s.id FROM sessions s
      WHERE s.task_id = tasks.id AND s.kind = 'thread'
      ORDER BY s.created_at, s.id
      LIMIT 1
    )
    WHERE deleted_at IS NULL
  `;
});
