/**
 * Adds assistant memory: an assistant's `core` document and its topics, one
 * row per (assistant, name), and the full-text index `memory.search` reads.
 *
 * - `size` is the body's length in characters (Unicode code points), stored
 *   so the index of topics and the cap checks never count a body again.
 * - `updated_by` is the actor stamp of the last write.
 * - `core` never has a gist, which a CHECK enforces.
 * - A document is deleted with its assistant, through the foreign key.
 *
 * The table has its own `INTEGER PRIMARY KEY`, because the full-text index
 * finds its rows by rowid. A table without one may have its rowids
 * renumbered by `VACUUM`, which the pre-migration backup runs, and the index
 * would then point at the wrong documents.
 *
 * Every assistant has a `core` from its creation on, so the migration gives
 * each existing assistant an empty one.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE memory_documents (
      id INTEGER PRIMARY KEY,
      assistant_id BLOB NOT NULL REFERENCES assistants (agent_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      gist TEXT NOT NULL,
      body TEXT NOT NULL,
      size INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      UNIQUE (assistant_id, name),
      CHECK (name <> 'core' OR gist = '')
    )
  `;

  yield* sql`
    CREATE VIRTUAL TABLE memory_documents_fts USING fts5(
      name,
      body,
      content = 'memory_documents',
      content_rowid = 'id',
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `;
  // SQLite does not maintain an external-content index, so these three
  // triggers keep it current, as for `tasks_fts` (migration 0003). Documents
  // are written with INSERT, UPDATE and DELETE and never with REPLACE: the row
  // a REPLACE displaces fires no delete trigger, so its terms would stay in
  // the index. A delete through the foreign key fires the delete trigger.
  yield* sql`
    CREATE TRIGGER memory_documents_fts_insert AFTER INSERT ON memory_documents BEGIN
      INSERT INTO memory_documents_fts (rowid, name, body) VALUES (new.id, new.name, new.body);
    END
  `;
  yield* sql`
    CREATE TRIGGER memory_documents_fts_delete AFTER DELETE ON memory_documents BEGIN
      INSERT INTO memory_documents_fts (memory_documents_fts, rowid, name, body)
      VALUES ('delete', old.id, old.name, old.body);
    END
  `;
  yield* sql`
    CREATE TRIGGER memory_documents_fts_update AFTER UPDATE OF name, body ON memory_documents BEGIN
      INSERT INTO memory_documents_fts (memory_documents_fts, rowid, name, body)
      VALUES ('delete', old.id, old.name, old.body);
      INSERT INTO memory_documents_fts (rowid, name, body) VALUES (new.id, new.name, new.body);
    END
  `;

  yield* sql`
    INSERT INTO memory_documents (assistant_id, name, gist, body, size, updated_at, updated_by)
    SELECT agent_id, 'core', '', '', 0, created_at, 'system' FROM assistants
  `;
});
