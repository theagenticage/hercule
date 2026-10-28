/**
 * Adds `session_edits` (spec 19 section 2.4): one row per session, repository
 * and file path, with the time of the session's first edit of it. Edit
 * Overlaps are found from these rows (spec 19 section 4.3).
 *
 * `resource_id` has no foreign key on purpose, as in `discussions`: the rows
 * outlive their Resource and keep its id. `session_id` references `sessions`,
 * because a session is never deleted.
 *
 * The index finds the sessions that edited one file of one repository, which
 * is the question every reported edit asks.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE session_edits (
      session_id BLOB NOT NULL REFERENCES sessions (id),
      resource_id BLOB NOT NULL,
      path TEXT NOT NULL,
      edited_at TEXT NOT NULL,
      PRIMARY KEY (session_id, resource_id, path)
    )
  `;
  yield* sql`CREATE INDEX session_edits_by_file ON session_edits (resource_id, path)`;
});
