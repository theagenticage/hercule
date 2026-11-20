/**
 * Adds the two tables that hold a list of MCP Servers: a Project's default
 * list and a Session's own list (spec 21 section 4.1).
 *
 * - `project_mcp_servers` holds the servers a new Thread in the Project
 *   starts with. One row is one entry, and `position` keeps the order the
 *   caller gave.
 * - `session_mcp_servers` holds a session's own list. Each row also keeps
 *   the server's `name` as it was when the entry was written, and `left_out`:
 *   the reason the last start left the server out, or NULL when it could be
 *   called or has not been checked at a start yet.
 *
 * `mcp_server_id` references `mcp_servers` with no cascade. Deleting a server
 * has to go through the lists' adapter, which also announces every record
 * that loses the server. A plain delete of a server that a list still names
 * fails.
 *
 * `project_id` and `session_id` reference their owners with no cascade, as
 * every other table does: a Project is deleted softly and a session is never
 * deleted, so its rows stay.
 *
 * The primary key is `(owner, position)`, so a list is read in order by its
 * owner. The index on `mcp_server_id` serves the delete of a server, which
 * looks up every row that names it.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE project_mcp_servers (
      project_id BLOB NOT NULL REFERENCES projects (id),
      position INTEGER NOT NULL,
      mcp_server_id BLOB NOT NULL REFERENCES mcp_servers (id),
      PRIMARY KEY (project_id, position),
      UNIQUE (project_id, mcp_server_id)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX project_mcp_servers_server ON project_mcp_servers (mcp_server_id)
  `;

  yield* sql`
    CREATE TABLE session_mcp_servers (
      session_id BLOB NOT NULL REFERENCES sessions (id),
      position INTEGER NOT NULL,
      mcp_server_id BLOB NOT NULL REFERENCES mcp_servers (id),
      name TEXT NOT NULL,
      left_out TEXT
        CHECK (left_out IS NULL OR left_out IN (
          'switched-off', 'checking', 'needs-sign-in', 'unreachable', 'error',
          'runner-too-old', 'harness-unsupported', 'missing-grant'
        )),
      PRIMARY KEY (session_id, position),
      UNIQUE (session_id, mcp_server_id)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX session_mcp_servers_server ON session_mcp_servers (mcp_server_id)
  `;
});
