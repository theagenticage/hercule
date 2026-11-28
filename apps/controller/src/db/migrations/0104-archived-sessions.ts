/**
 * Adds what archiving a Thread needs (spec 02, Archived; spec 03 §6.7):
 *
 * - `sessions.archived_at` and `sessions.archived_by`: when the Thread was
 *   archived and the actor who archived it. Both are set together, so a check
 *   refuses a row with only one of them. Every existing session gets `NULL`:
 *   no Thread was archived before this migration;
 * - `workspace_leases.retention` may now be `archived`: the retention of a
 *   released lease whose holder is an archived Thread. SQLite cannot change a
 *   CHECK in place, so the table is rebuilt with every row, the primary key,
 *   the released/retention/kept_until check and the holder index kept.
 *
 * No other table has a foreign key to `workspace_leases`, so it can be
 * rebuilt alone. The rebuild rewrites existing rows, so the upgrade test
 * (`e2e/upgrade.test.ts`) seeds leases with the previous build.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE sessions ADD COLUMN archived_at TEXT`;
  yield* sql`
    ALTER TABLE sessions ADD COLUMN archived_by TEXT
      CHECK ((archived_by IS NULL) = (archived_at IS NULL))
  `;
  yield* sql`
    CREATE TABLE workspace_leases_next (
      workspace_id BLOB NOT NULL REFERENCES workspaces(id),
      holder_kind TEXT NOT NULL CHECK (holder_kind IN ('session', 'run')),
      holder_id BLOB NOT NULL,
      acquired_at TEXT NOT NULL,
      released_at TEXT,
      retention TEXT CHECK (retention IN ('none', 'orphan', 'idle', 'inspection', 'archived')),
      kept_until TEXT,
      CHECK ((released_at IS NULL) = (retention IS NULL) AND (released_at IS NULL) = (kept_until IS NULL)),
      PRIMARY KEY (workspace_id, holder_kind, holder_id)
    )
  `;
  yield* sql`INSERT INTO workspace_leases_next SELECT * FROM workspace_leases`;
  yield* sql`DROP TABLE workspace_leases`;
  yield* sql`ALTER TABLE workspace_leases_next RENAME TO workspace_leases`;
  yield* sql`CREATE INDEX workspace_leases_holder ON workspace_leases(holder_kind, holder_id)`;
});
