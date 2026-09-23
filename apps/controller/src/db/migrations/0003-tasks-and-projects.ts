/**
 * Tasks and Projects: the two places intent is written down, and the full-text
 * index over tasks.
 *
 * Both are soft-deleted, so `deleted_at` decides whether a row is live, and
 * **every index on either table is partial on `deleted_at IS NULL`**. A
 * deleted row then drops out of the indexes instead of sitting in them behind
 * a filter, and "every live task in order of update" stays one index scan. That
 * is also why deletion is a column and not a fifth status: no index can serve
 * the inequality `status <> 'deleted'`.
 *
 * `labels` is a JSON array on the task row rather than a child table. It is
 * read on every page and written whole by every update, so a join would read
 * a set of rows for what is one value of the task. The cost is that no index
 * can serve a filter on a label: the filter is an `EXISTS` over `json_each`,
 * which reads every live task. That measured 12 ms a page against 50k tasks,
 * whether the label matches one row or none. An index would need a child
 * table, which is a migration and a bigger decision than this one.
 *
 * Provenance is the opposite case and is a child table: entries are appended
 * one at a time, never edited, and each has its own actor and timestamp.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A way to group information inside Hercule. It has no behaviour: no
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

  // A unit of human intent. `status_changed_at` changes only when `status`
  // does, so "in progress since" can be read from the row.
  // A task keeps its `project_id` when the project is soft-deleted, so the
  // reference points at a row that still exists, though it is no longer live.
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
  // The default order, which every other filter narrows: the next page starts
  // after the `(updated_at, id)` pair the cursor holds.
  yield* sql`
    CREATE INDEX tasks_updated_at ON tasks (updated_at, id) WHERE deleted_at IS NULL
  `;
  yield* sql`
    CREATE INDEX tasks_created_at ON tasks (created_at, id) WHERE deleted_at IS NULL
  `;
  // Status is read in two ways, and each needs its own index. Keyset paging
  // resumes on `(key, id)`, so a sort on status orders by `(status, id)`, which
  // is not a prefix of the order a status filter needs.
  //
  // `tasks_status` serves the sort. Without it SQLite reads the whole table and
  // builds a temporary b-tree for the id part of the order. That measured 4 ms
  // a page against 50k rows, the same for every page.
  yield* sql`
    CREATE INDEX tasks_status ON tasks (status, id) WHERE deleted_at IS NULL
  `;
  // `tasks_status_updated_at` serves the filter, which is the more common
  // query: "the open tasks, newest first". Without it the filter falls back to
  // `tasks_updated_at`, which costs 5 ms a page for a status few tasks have,
  // because the scan reads every row until it finds fifty. Two indexes on one
  // column cost extra on each write, which is cheap for a table people write
  // by hand.
  yield* sql`
    CREATE INDEX tasks_status_updated_at ON tasks (status, updated_at, id)
    WHERE deleted_at IS NULL
  `;
  // Priorities are stored as words but ordered as ranks: alphabetical order
  // would put `high` before `low` before `normal` before `urgent`, which is not
  // an order anyone wants. Sorting on this expression reads the index in order
  // rather than sorting in memory; the query has to write the expression the
  // same way. The keyset comparison on it filters rather than seeks, so a later
  // page reads past all the rows before it.
  yield* sql`
    CREATE INDEX tasks_priority ON tasks (
      CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      id
    ) WHERE deleted_at IS NULL
  `;
  yield* sql`
    CREATE INDEX tasks_project ON tasks (project_id, updated_at, id) WHERE deleted_at IS NULL
  `;

  // A task's append-only record of what created or changed it. Every field but
  // `at` and `actor` is optional and an entry may have any combination, but an
  // entry with none of the three is not provenance. The service rejects it; a
  // CHECK here would put the same rule in a second place.
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
  // The duplicate-signal query: which tasks already have this External Ref.
  yield* sql`CREATE INDEX task_provenance_ref ON task_provenance (ref) WHERE ref IS NOT NULL`;

  // A project spans resources and a resource joins any number of projects.
  // Resources have no table yet, so `resource_id` has no foreign key.
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
  // where the search filters on `deleted_at`. So search never returns a deleted
  // task, even though the index knows nothing about deletion.
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
  // SQLite does not maintain an external-content index, so these three
  // triggers keep it current. A delete is written as a special row into the
  // index rather than removed from it, which is how fts5 records a delete.
  //
  // Tasks are written with INSERT, UPDATE and DELETE and never with REPLACE.
  // The row a REPLACE displaces is removed without firing a delete trigger, so
  // its terms would stay in the index and match a row that no longer exists.
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
  // Only changes to the two indexed columns fire this trigger. A status change
  // or a soft delete leaves the terms alone; a soft-deleted task is filtered
  // out on the join to `tasks` instead.
  yield* sql`
    CREATE TRIGGER tasks_fts_update AFTER UPDATE OF title, description ON tasks BEGIN
      INSERT INTO tasks_fts (tasks_fts, rowid, title, description)
      VALUES ('delete', old.rowid, old.title, old.description);
      INSERT INTO tasks_fts (rowid, title, description)
      VALUES (new.rowid, new.title, new.description);
    END
  `;
});
