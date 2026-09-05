/**
 * The fleet: one row per runner the controller has enlisted.
 *
 * Most of the row is what the runner reports over its socket, and none of it
 * exists before the runner first connects: its version, the capabilities the
 * hello negotiated, the facts it probed and the watermark it refreshes are all
 * nullable, and `last_seen_at` is null until the first hello.
 *
 * `facts` and `watermark` are JSON documents rather than columns because
 * nothing queries inside them: they are read whole with the row and written
 * whole by each report. Spreading them over twenty columns would mean a
 * migration every time a runner learns to report one more thing.
 *
 * The credential is the durable bearer token a runner presents on the socket
 * upgrade, and only its hash is here. The index over it is unique because two
 * runners sharing a credential would make the upgrade ambiguous, and it is what
 * the upgrade looks the runner up by.
 *
 * The bounds the contract puts on a name and a session cap are repeated as
 * CHECK constraints because SQLite has no way to add one to a table later: the
 * alternative to writing them here is rebuilding the table.
 *
 * A retired runner keeps its row: its sessions and workspaces still name it,
 * and re-enlisting the same machine writes a new row rather than reviving this
 * one.
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
  // The order the fleet is read in: a keyset walk resumes on the `(name, id)`
  // pair the cursor carries.
  yield* sql`CREATE INDEX runners_name ON runners (name, id)`;
  yield* sql`CREATE UNIQUE INDEX runners_credential_hash ON runners (credential_hash)`;
});
