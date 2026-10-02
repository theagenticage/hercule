/**
 * Adds `connections.account_id`: the provider's stable id for the account a
 * connection signs in as, which the type's `validate` returns. Unlike the
 * account name in `display_name`, it stays the same when the account is
 * renamed, so a reconnect can check that it signs in to the same account.
 *
 * The column is NOT NULL, and an existing connection has no account id to put
 * in it: only a sign-in with the connection's credentials can learn the id.
 * So the migration refuses a database that holds any connection, and
 * otherwise rebuilds the empty table with the new column. SQLite cannot add a
 * NOT NULL column without a default in place.
 *
 * The rebuild creates `connections_new`, drops `connections` and renames
 * `connections_new` in its place, in that order. `resources` and
 * `workspaces` reference `connections (id)`, and SQLite rewrites references
 * to a table that is renamed. Nothing references `connections_new`, so the
 * references in those two tables keep naming `connections` and point at the
 * new table. Foreign keys stay on throughout: the table is empty, so the
 * implicit delete of `DROP TABLE` breaks no reference.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The database holds connections, which this migration cannot give an
 * account id. The boot prints the message after the name of the migration.
 */
class ExistingConnectionsError extends Data.TaggedError("ExistingConnectionsError")<{
  readonly message: string;
}> {}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const [counted] = yield* sql<{ readonly count: number }>`
    SELECT count(*) AS count FROM connections`;
  const count = counted?.count ?? 0;
  if (count > 0) {
    return yield* new ExistingConnectionsError({
      message:
        `This version stores the account each connection belongs to, and cannot add it to ` +
        `the ${count} existing ${count === 1 ? "connection" : "connections"}. Start a fresh ` +
        `Hercule Home, or delete the connections with the previous version first.`,
    });
  }

  yield* sql`
    CREATE TABLE connections_new (
      id BLOB PRIMARY KEY NOT NULL,
      plugin_id TEXT NOT NULL,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      display_name TEXT NOT NULL,
      account_id TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('connected', 'needs-reauth', 'error', 'disabled')),
      status_detail TEXT,
      labels TEXT NOT NULL CHECK (json_valid(labels)),
      config TEXT NOT NULL CHECK (json_valid(config)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`DROP TABLE connections`;
  yield* sql`ALTER TABLE connections_new RENAME TO connections`;
  // Dropping the old table dropped its index too.
  yield* sql`CREATE INDEX connections_by_plugin ON connections (plugin_id)`;
});
