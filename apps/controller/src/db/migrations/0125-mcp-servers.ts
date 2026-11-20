/**
 * Adds `mcp_servers`: the MCP Servers that sessions reach through the MCP
 * Gateway (spec 21). One row is one server the user switched on, made from a
 * plugin's contribution and one of its Connections.
 *
 * Identity and source:
 *
 * - `name` is what clients call the server. It is fixed at creation and may
 *   repeat: a work and a hobby Sentry are both `sentry`.
 * - `contribution_id` is the plugin's MCP server contribution, qualified
 *   (`sentry/sentry`).
 * - `connection_id` is the Connection the server is reached with. The
 *   reference has no cascade: the service refuses to delete a Connection a
 *   server uses, so the user removes the server first.
 * - `account_id` is the Connection's `account_id` when the server was created.
 *   It is copied here so that `UNIQUE (contribution_id, account_id)` can hold
 *   the rule "one server per contribution and external account" in the
 *   database itself.
 *
 * State the user sets and what the last check found:
 *
 * - `enabled` is the user's switch. Off is 0, never a delete.
 * - `status` and `status_detail` say what the last check or sign-in found, in
 *   words a person can act on.
 * - `status_cause` is set when the status follows the Connection or the
 *   plugin (for example "Connection switched off") and not the server itself.
 *   The follower that reacts to a Connection's or a plugin's change reads it
 *   to know which statuses it may move back.
 * - `tools` is a JSON array of the tools the server listed, each with its
 *   full definition (name, title, description, input schema, output schema,
 *   annotations). The gateway answers `tools/list` from it.
 * - `checked_at` is the time of the last successful list.
 * - `protocol_version` is the MCP revision the server answered with.
 *
 * Bookkeeping for checks:
 *
 * - `revision` goes up with every change that makes a running check's result
 *   stale or that ends upstream sessions: switching on or off, a reconnect and
 *   a delete. A check writes its result only if the revision is unchanged.
 * - `connection_generation` is the Connection's `credentials_generation` the
 *   server was last checked against, so a reconnect is noticed.
 * - `notified_status` is the status an open Notification episode is for, so
 *   one failure raises one Notification.
 * - `next_check_at` and `failed_checks` schedule the next check and its
 *   backoff after failures.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE mcp_servers (
      id BLOB PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      contribution_id TEXT NOT NULL,
      connection_id BLOB NOT NULL REFERENCES connections (id),
      account_id TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      status TEXT NOT NULL
        CHECK (status IN ('checking', 'ready', 'needs-sign-in', 'unreachable', 'error')),
      status_detail TEXT,
      status_cause TEXT,
      tools TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tools)),
      checked_at TEXT,
      protocol_version TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      connection_generation INTEGER NOT NULL DEFAULT 0,
      notified_status TEXT,
      next_check_at TEXT,
      failed_checks INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (contribution_id, account_id)
    )
  `;
  yield* sql`CREATE INDEX mcp_servers_connection ON mcp_servers (connection_id)`;
});
