/**
 * Sessions and their normalized streams.
 *
 * Nothing here is a foreign key. A session is history: it must outlive the
 * provider instance it named, the runner row it ran on and the permission
 * profile it copied, and neither cascade (which would delete the history) nor
 * restrict (which would make a provider instance undeletable for ever) is what
 * a record of what happened wants.
 *
 * `spec` holds the controller-authored `SessionSpec` byte for byte, as the
 * encoded JSON string that went out on the wire, because that string is what
 * the runner was told and a re-encode is not necessarily the same bytes.
 *
 * The stream is keyed by `(session_id, position)`, the per-session monotonic
 * position of spec 04, and carries the runner's own sequence number under a
 * unique index so an insert is idempotent on it: a replayed frame hits the
 * index rather than appending a second copy. A coalesced `content.delta` row
 * carries the sequence of the last delta folded into it.
 *
 * The bounds are CHECK constraints, which SQLite cannot add later without
 * rebuilding the table, so the status axis is written out; a landed migration
 * is frozen and widening it takes a migration of its own.
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
  // The one listing this build serves: newest first, filtered by status or by
  // runner, both of which are selective enough to leave to the scan.
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
