/**
 * Adds Permission Requests: a session asking the user for a grant its
 * Permission Profile lacks.
 *
 * - A request is `open` until the user decides it or its session ends.
 * - A decided request records the outcome: `session` lets only the asking
 *   session use the grant, `profile` added the grant to the session's
 *   profile, and `deny` refused it.
 * - A request whose session ended while it was open is `withdrawn`.
 *
 * The grants of a session are its profile's grants plus the grants of its
 * requests decided with outcome `session` under that same profile, so the
 * token check reads this table by session. `profile_id` is the profile the
 * session was on when it asked. It has no foreign key, like
 * `sessions.permission_profile_id`, so deleting a profile is not blocked by
 * the requests of sessions that ended long ago.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE permission_requests (
      id BLOB PRIMARY KEY NOT NULL,
      session_id BLOB NOT NULL REFERENCES sessions (id),
      profile_id BLOB NOT NULL,
      grant TEXT NOT NULL,
      reason TEXT NOT NULL,
      operation TEXT CHECK (operation IS NULL OR json_valid(operation)),
      status TEXT NOT NULL CHECK (status IN ('open', 'decided', 'withdrawn')),
      outcome TEXT CHECK (outcome IS NULL OR outcome IN ('session', 'profile', 'deny')),
      created_at TEXT NOT NULL,
      decided_at TEXT,
      -- Only a decided request has an outcome and a decision time.
      CHECK ((status = 'decided') = (outcome IS NOT NULL)),
      CHECK ((status = 'decided') = (decided_at IS NOT NULL))
    )
  `;
  // Serves the token check, which reads a session's decided requests, and the
  // session record, which lists a session's open ones.
  yield* sql`
    CREATE INDEX permission_requests_by_session ON permission_requests (session_id, status)
  `;
  // A session asks for a grant at most once at a time. permission.request
  // checks this itself, inside its transaction, to name the open request in
  // its refusal. The database client runs one transaction at a time, so two
  // requests cannot both pass that check; the index is a safety net against
  // a future writer that skips it.
  yield* sql`
    CREATE UNIQUE INDEX permission_requests_one_open
    ON permission_requests (session_id, grant) WHERE status = 'open'
  `;
});
