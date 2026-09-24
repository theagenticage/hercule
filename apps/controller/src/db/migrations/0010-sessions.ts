/**
 * Sessions and their normalized streams.
 *
 * Nothing here is a foreign key. A session is history: it must outlive the
 * provider instance it used, the runner row it ran on and the permission
 * profile it copied. Neither cascade (which would delete the history) nor
 * restrict (which would make a provider instance impossible to delete) suits a
 * record of what happened.
 *
 * `spec` holds the `SessionSpec` the controller wrote, byte for byte, as the
 * encoded JSON string sent to the runner. That string is exactly what the
 * runner received, and encoding it again does not always give the same bytes.
 *
 * The stream is keyed by `(session_id, position)`, the per-session position
 * that only increases (spec 04). It also stores the runner's own sequence
 * number under a unique index, so inserting the same frame twice is a no-op: a
 * replayed frame hits the index rather than adding a second copy. A merged
 * `content.delta` row stores the sequence number of the last delta merged into
 * it.
 *
 * The bounds are CHECK constraints, which SQLite cannot add later without
 * rebuilding the table, so the status values are written out. A migration that
 * has shipped never changes, so adding a status needs a new migration.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE sessions (
      id BLOB PRIMARY KEY NOT NULL,
      permission_profile_id BLOB NOT NULL,
      instance_id BLOB NOT NULL,
      runner_id BLOB NOT NULL,
      workspace_id BLOB,
      requested_access_mode TEXT NOT NULL,
      access_mode TEXT NOT NULL,
      spec TEXT NOT NULL CHECK (json_valid(spec)),
      -- The prompt's first non-empty line, capped: set once at open, so a
      -- sidebar row has something to show without reading the transcript.
      title TEXT NOT NULL,
      native_session_id TEXT,
      status TEXT NOT NULL
        CHECK (status IN ('queued', 'starting', 'idle', 'busy', 'exited')),
      created_at TEXT NOT NULL,
      started_at TEXT,
      exited_at TEXT,
      last_activity_at TEXT NOT NULL
    )
  `;
  // The only session list so far: newest first, filtered by status or by
  // runner. Both filters are selective enough to apply during the scan.
  yield* sql`CREATE INDEX sessions_created ON sessions (created_at DESC, id DESC)`;
  yield* sql`
    CREATE TABLE session_stream (
      session_id BLOB NOT NULL,
      position INTEGER NOT NULL,
      runner_seq INTEGER NOT NULL,
      at TEXT NOT NULL,
      event TEXT NOT NULL CHECK (json_valid(event)),
      PRIMARY KEY (session_id, position)
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX session_stream_seq ON session_stream (session_id, runner_seq)
  `;
});
