/**
 * Adds Initiatives, and the blockers between Tasks.
 *
 * - `initiatives` has one row per Initiative. `hue` is one of the contract's
 *   `INITIATIVE_HUES`; the contract checks it, not the table, so a longer list
 *   later needs no migration. `closed_at` is set while the Initiative is
 *   closed, and `deleted_at` when it is deleted. `created_by` and `updated_by`
 *   are actor stamps. `project_id` is not cleared when the project is
 *   deleted: a client treats a project that is no longer listed as none.
 *   Reads list the open ones, or the closed ones, in `(created_at, id)`
 *   order, so each has a partial index of its own. A query uses an index only
 *   when it writes the same `closed_at` condition as the index.
 * - `task_blockers` has one row per "this Task waits on that Task". It stores
 *   one direction only: what a Task blocks is the same rows read the other
 *   way, which the index on `blocked_by_task_id` serves. The `CHECK` refuses
 *   a Task that waits on itself. The service keeps the relation free of loops;
 *   the table cannot.
 * - `tasks.initiative_id` is the Initiative a Task belongs to, if any. A Task
 *   keeps it when the Initiative is closed; a delete clears it. Two partial
 *   indexes serve it. `tasks_initiative` holds the Tasks that are live and on
 *   an Initiative, so reading or clearing one Initiative's Tasks costs what
 *   they are, not the number of Tasks. Its size follows the Tasks that were
 *   ever put on an Initiative, closed ones included. `tasks_initiative_done`
 *   holds only those at the stage `done` and not merged, so the board's Done
 *   count of an Initiative is answered from the index alone. It lists the
 *   columns of its own condition as well, because SQLite reads the table row
 *   for a column the query mentions, even one the condition already fixes.
 *
 * The migration only adds tables, a column and indexes, so the upgrade test
 * needs no fixture for it.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE initiatives (
      id BLOB PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      intent TEXT NOT NULL,
      target TEXT,
      target_date TEXT,
      hue INTEGER NOT NULL,
      project_id BLOB REFERENCES projects (id),
      closed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      deleted_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX initiatives_open ON initiatives (created_at, id)
    WHERE deleted_at IS NULL AND closed_at IS NULL
  `;
  yield* sql`
    CREATE INDEX initiatives_closed ON initiatives (created_at, id)
    WHERE deleted_at IS NULL AND closed_at IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE task_blockers (
      task_id BLOB NOT NULL REFERENCES tasks (id),
      blocked_by_task_id BLOB NOT NULL REFERENCES tasks (id),
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      PRIMARY KEY (task_id, blocked_by_task_id),
      CHECK (task_id <> blocked_by_task_id)
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX task_blockers_blocked_by ON task_blockers (blocked_by_task_id)`;

  yield* sql`ALTER TABLE tasks ADD COLUMN initiative_id BLOB REFERENCES initiatives (id)`;
  yield* sql`
    CREATE INDEX tasks_initiative ON tasks (initiative_id, id)
    WHERE deleted_at IS NULL AND initiative_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX tasks_initiative_done
    ON tasks (initiative_id, deleted_at, merged_into_id, stage)
    WHERE deleted_at IS NULL AND merged_into_id IS NULL AND initiative_id IS NOT NULL
      AND stage = 'done'
  `;
});
