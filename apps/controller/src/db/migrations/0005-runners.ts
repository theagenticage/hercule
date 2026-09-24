/**
 * The fleet: one row per runner the controller has enlisted.
 *
 * The columns the runner reports are nullable, because they have no value
 * before the runner first connects. `facts` and `watermark` are JSON documents
 * because nothing queries inside them, and columns would mean a migration per
 * new reported field.
 *
 * Only the credential's hash is here, and its index is unique because two
 * runners sharing one would make the socket upgrade ambiguous.
 *
 * The contract's bounds are repeated as CHECK constraints because SQLite cannot
 * add one later without rebuilding the table.
 *
 * A retired runner keeps its row: its sessions still refer to it, and
 * re-enlisting writes a new row rather than reviving the old one.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE runners (
      id BLOB PRIMARY KEY NOT NULL,
      name TEXT NOT NULL CHECK (length(name) > 0),
      state TEXT NOT NULL CHECK (
        state IN ('online', 'offline', 'unreachable', 'draining', 'retired')
      ),
      labels TEXT NOT NULL,
      max_concurrent_sessions INTEGER NOT NULL CHECK (max_concurrent_sessions >= 1),
      credential_hash TEXT NOT NULL,
      binary_version TEXT,
      protocol_version INTEGER,
      negotiated_capabilities TEXT,
      facts TEXT,
      watermark TEXT,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // Keyset paging resumes after the `(name, id)` pair the cursor holds.
  yield* sql`CREATE INDEX runners_name ON runners (name, id)`;
  yield* sql`CREATE UNIQUE INDEX runners_credential_hash ON runners (credential_hash)`;
});
