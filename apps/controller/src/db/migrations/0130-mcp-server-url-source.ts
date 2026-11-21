/**
 * Lets an MCP Server come from an address the user gave, besides a plugin's
 * contribution (spec 21 section 2), and lets a secret belong to an MCP Server.
 *
 * `mcp_servers` gets a source, one of two kinds:
 *
 * - `plugin`: a plugin's contribution reached with one of its Connections.
 *   This is every row that exists before the migration. It keeps
 *   `contribution_id`, `connection_id` and `account_id`, which are now null
 *   for the other kind.
 * - `url`: an address, reached with the server's own sign-in.
 *   - `url` is the address as the user gave it, and the one requests go to.
 *   - `normalized_url` is the key that makes two spellings of one address
 *     count as one server, so `UNIQUE (normalized_url)` keeps one server per
 *     address. A plugin row has none, and SQLite lets any number of null
 *     values share a unique index.
 *   - `sign_in` is what the server holds: `none`, a pasted `token`, or
 *     `oauth` tokens. The tokens themselves are secrets, not columns.
 *   - `sign_in_offered` is what the server said it accepts when it refused a
 *     request that carried no sign-in, or null while that has not happened.
 *
 * A table CHECK says that each kind has exactly its own columns. It writes
 * every test as `IS NULL` or `IS NOT NULL`, because SQLite accepts a row
 * when a CHECK evaluates to NULL, and a bare `column = value` on a null column
 * would let a mixed row through.
 *
 * SQLite cannot make a NOT NULL column nullable, so `mcp_servers` is rebuilt.
 * `project_mcp_servers` and `session_mcp_servers` reference it, and foreign
 * keys stay on inside a migration's transaction: dropping the old table while
 * those lists hold rows fails, even with the check deferred to the commit. So
 * the migration copies both lists to temporary tables, empties them, rebuilds
 * `mcp_servers`, and puts the rows back unchanged. The two list tables are
 * never dropped, so their definitions, their indexes and their reference to
 * `mcp_servers` stay as they were, and the reference points at the new table
 * as soon as it takes the old table's name.
 *
 * The rebuilt table keeps every old column in its old order, with the new
 * ones before `tools`. `tools` stays the last column on purpose (see
 * 0125-mcp-servers.ts): a read that leaves it out never steps over its
 * overflow pages.
 *
 * `secrets` gets the owner kind `mcp-server`: its owner id is the server's id.
 * SQLite cannot change the CHECK that lists the owner kinds, so the table is
 * rebuilt as in 0095-provider-accounts.ts. No table references `secrets`.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TEMP TABLE staged_project_mcp_servers AS SELECT * FROM project_mcp_servers`;
  yield* sql`CREATE TEMP TABLE staged_session_mcp_servers AS SELECT * FROM session_mcp_servers`;
  yield* sql`DELETE FROM project_mcp_servers`;
  yield* sql`DELETE FROM session_mcp_servers`;

  yield* sql`
    CREATE TABLE mcp_servers_next (
      id BLOB PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('plugin', 'url')),
      contribution_id TEXT,
      connection_id BLOB REFERENCES connections (id),
      account_id TEXT,
      url TEXT,
      normalized_url TEXT,
      sign_in TEXT CHECK (sign_in IN ('none', 'token', 'oauth')),
      sign_in_offered TEXT CHECK (sign_in_offered IN ('oauth', 'token')),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      status TEXT NOT NULL
        CHECK (status IN ('checking', 'ready', 'needs-sign-in', 'unreachable', 'error')),
      status_detail TEXT,
      status_cause TEXT,
      checked_at TEXT,
      protocol_version TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      connection_generation INTEGER NOT NULL DEFAULT 0,
      notified_status TEXT,
      next_check_at TEXT,
      failed_checks INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      tools TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tools)),
      UNIQUE (contribution_id, account_id),
      UNIQUE (normalized_url),
      CHECK (
        (
          source_kind = 'plugin'
          AND contribution_id IS NOT NULL
          AND connection_id IS NOT NULL
          AND account_id IS NOT NULL
          AND url IS NULL
          AND normalized_url IS NULL
          AND sign_in IS NULL
          AND sign_in_offered IS NULL
        )
        OR (
          source_kind = 'url'
          AND contribution_id IS NULL
          AND connection_id IS NULL
          AND account_id IS NULL
          AND url IS NOT NULL
          AND normalized_url IS NOT NULL
          AND sign_in IS NOT NULL
        )
      )
    )
  `;
  yield* sql`
    INSERT INTO mcp_servers_next
      (id, name, source_kind, contribution_id, connection_id, account_id, enabled, status,
       status_detail, status_cause, checked_at, protocol_version, revision,
       connection_generation, notified_status, next_check_at, failed_checks, created_at,
       updated_at, tools)
    SELECT id, name, 'plugin', contribution_id, connection_id, account_id, enabled, status,
           status_detail, status_cause, checked_at, protocol_version, revision,
           connection_generation, notified_status, next_check_at, failed_checks, created_at,
           updated_at, tools
    FROM mcp_servers
  `;
  yield* sql`DROP TABLE mcp_servers`;
  yield* sql`ALTER TABLE mcp_servers_next RENAME TO mcp_servers`;
  // Dropping a table drops its indexes, so the one 0125 made is made again.
  yield* sql`CREATE INDEX mcp_servers_connection ON mcp_servers (connection_id)`;

  yield* sql`
    INSERT INTO project_mcp_servers (project_id, position, mcp_server_id)
    SELECT project_id, position, mcp_server_id FROM staged_project_mcp_servers
  `;
  yield* sql`
    INSERT INTO session_mcp_servers (session_id, position, mcp_server_id, left_out)
    SELECT session_id, position, mcp_server_id, left_out FROM staged_session_mcp_servers
  `;
  yield* sql`DROP TABLE staged_project_mcp_servers`;
  yield* sql`DROP TABLE staged_session_mcp_servers`;

  yield* sql`
    CREATE TABLE secrets_next (
      id BLOB PRIMARY KEY NOT NULL,
      owner_kind TEXT NOT NULL CHECK (
        owner_kind IN (
          'connection', 'plugin', 'runner', 'core', 'provider-account', 'mcp-server'
        )
      ),
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      nonce BLOB NOT NULL,
      ciphertext BLOB NOT NULL,
      created_at TEXT NOT NULL,
      rotated_at TEXT
    )
  `;
  yield* sql`
    INSERT INTO secrets_next
      (id, owner_kind, owner_id, name, nonce, ciphertext, created_at, rotated_at)
    SELECT id, owner_kind, owner_id, name, nonce, ciphertext, created_at, rotated_at
    FROM secrets
  `;
  yield* sql`DROP TABLE secrets`;
  yield* sql`ALTER TABLE secrets_next RENAME TO secrets`;
  // The two indexes the table had: `secrets_owner_name` (0001) and `secrets_name` (0002).
  yield* sql`CREATE UNIQUE INDEX secrets_owner_name ON secrets (owner_kind, owner_id, name)`;
  yield* sql`CREATE INDEX secrets_name ON secrets (name, id)`;
});
