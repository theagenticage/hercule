/**
 * Tasks and Projects: the two places intent is written down, and the full-text
 * index over tasks.
 *
 * Both are soft-deleted, so `deleted_at` is the fact that decides whether a row
 * is live, and **every index on either table is partial on `deleted_at IS NULL`**.
 * A deleted row then drops out of the indexes instead of sitting in them behind
 * a filter, and "every live task in updated order" stays one index walk. That
 * is also why deletion is a column and not a fifth status: `status <> 'deleted'`
 * is an inequality no index serves.
 *
 * `labels` is a JSON array on the task row rather than a child table. It is
 * read on every page and written whole by every update, so a join would cost a
 * row set for something that is one value of the task.
 *
 * Provenance is the opposite case and is a child table: entries are appended
 * one at a time, never edited, and each carries its own actor and timestamp.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A way to group information inside Hydra. It carries no behaviour: no
  // default connection, no status, nothing derived.
  yield* sql`
    CREATE TABLE projects (
      id BLOB PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX projects_name ON projects (name, id) WHERE deleted_at IS NULL
  `;
  yield* sql`
    CREATE INDEX projects_created_at ON projects (created_at, id) WHERE deleted_at IS NULL
  `;
  yield* sql`
    CREATE INDEX projects_updated_at ON projects (updated_at, id) WHERE deleted_at IS NULL
  `;

  // A unit of human intent. `status_changed_at` moves only when `status` does,
  // which is what lets "in progress since" be read off the row.
  // A task keeps its `project_id` when the project is soft-deleted, so the
  // reference is to a row that is still there rather than to a live one.
  yield* sql`
    CREATE TABLE tasks (
      id BLOB PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'in-progress', 'done', 'cancelled')),
      priority TEXT NOT NULL CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
      labels TEXT NOT NULL DEFAULT '[]',
      project_id BLOB REFERENCES projects (id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status_changed_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;
  // The default order, and the one every other filter narrows: a keyset walk
  // resumes on the `(updated_at, id)` pair the cursor carries.
  yield* sql`
    CREATE INDEX tasks_updated_at ON tasks (updated_at, id) WHERE deleted_at IS NULL
  `;
  yield* sql`
    CREATE INDEX tasks_created_at ON tasks (created_at, id) WHERE deleted_at IS NULL
  `;
  // Status is a filter far more often than a sort, so this serves "the open
  // tasks, newest first". Ordering by status itself is four values deep and
  // sorts in memory; a second index for that would cost every write.
  yield* sql`
    CREATE INDEX tasks_status ON tasks (status, updated_at, id) WHERE deleted_at IS NULL
  `;
  // Priorities are stored as words but ordered as ranks: alphabetical order
  // would put `high` before `low` before `normal` before `urgent`, which is not
  // an order anyone asked for. Sorting on this expression reads the index in
  // order rather than sorting in memory; the query has to spell the expression
  // the same way. The keyset comparison over it filters rather than seeks, so a
  // later page reads past the rows before it.
  yield* sql`
    CREATE INDEX tasks_priority ON tasks (
      CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      id
    ) WHERE deleted_at IS NULL
  `;
  yield* sql`
    CREATE INDEX tasks_project ON tasks (project_id, updated_at, id) WHERE deleted_at IS NULL
  `;

  // A task's append-only record of what created or touched it. Every field but
  // `at` and `actor` is optional and an entry may carry any combination, but an
  // entry naming none of the three is not provenance; the service refuses it,
  // because a CHECK here would be a second place to read the rule from.
  // `event_id` is an integer: the event log's id is its log position.
  yield* sql`
    CREATE TABLE task_provenance (
      id BLOB PRIMARY KEY NOT NULL,
      task_id BLOB NOT NULL REFERENCES tasks (id),
      ref TEXT,
      event_id INTEGER,
      run_id BLOB,
      at TEXT NOT NULL,
      actor TEXT NOT NULL
    )
  `;
  // One page of tasks joins its provenance in one pass, in append order.
  yield* sql`CREATE INDEX task_provenance_task ON task_provenance (task_id, id)`;
  // The duplicate-signal query: which tasks already carry this External Ref.
  yield* sql`CREATE INDEX task_provenance_ref ON task_provenance (ref) WHERE ref IS NOT NULL`;

  // A project spans resources and a resource joins any number of projects.
  // Resources have no table yet, so `resource_id` carries no foreign key.
  yield* sql`
    CREATE TABLE project_resources (
      project_id BLOB NOT NULL REFERENCES projects (id),
      resource_id BLOB NOT NULL,
      PRIMARY KEY (project_id, resource_id)
    ) WITHOUT ROWID
  `;
  yield* sql`CREATE INDEX project_resources_resource ON project_resources (resource_id)`;

  // Full-text over the two fields a person writes prose into. External content:
  // the index stores terms only and the rows stay in `tasks`, which is also
  // where the search filters `deleted_at`, so a deleted task is unreachable
  // through search without the index knowing anything about deletion.
  // `remove_diacritics 2` folds the whole Unicode range, so `cafe` finds
  // `Café`; without it only Latin-1 would fold.
  yield* sql`
    CREATE VIRTUAL TABLE tasks_fts USING fts5(
      title,
      description,
      content = 'tasks',
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `;
  // An external-content index is not maintained by SQLite: these three triggers
  // are what keep it current. A delete is written as a row into the index
  // rather than removed from it, which is how fts5 spells one.
  //
  // Tasks are written with INSERT, UPDATE and DELETE and never with REPLACE.
  // The row a REPLACE displaces is removed without firing a delete trigger, so
  // its terms would stay in the index and answer for a row that is gone.
  yield* sql`
    CREATE TRIGGER tasks_fts_insert AFTER INSERT ON tasks BEGIN
      INSERT INTO tasks_fts (rowid, title, description)
      VALUES (new.rowid, new.title, new.description);
    END
  `;
  yield* sql`
    CREATE TRIGGER tasks_fts_delete AFTER DELETE ON tasks BEGIN
      INSERT INTO tasks_fts (tasks_fts, rowid, title, description)
      VALUES ('delete', old.rowid, old.title, old.description);
    END
  `;
  // Only the two indexed columns fire it: a status change or a soft delete
  // leaves the terms alone, and a soft-deleted task is filtered out on the join
  // to `tasks` instead.
  yield* sql`
    CREATE TRIGGER tasks_fts_update AFTER UPDATE OF title, description ON tasks BEGIN
      INSERT INTO tasks_fts (tasks_fts, rowid, title, description)
      VALUES ('delete', old.rowid, old.title, old.description);
      INSERT INTO tasks_fts (rowid, title, description)
      VALUES (new.rowid, new.title, new.description);
    END
  `;
});
