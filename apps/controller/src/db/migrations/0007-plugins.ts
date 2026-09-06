/**
 * What the controller keeps about the plugins compiled into it.
 *
 * `plugins` holds the user's intent and nothing else; runtime state is a fact
 * about the current process and stays in memory, so a restart is the retry a
 * broken plugin gets. `plugin_contributions` is the catalog every consumer
 * reads instead of the live plugin object, which is what lets the UI say what a
 * disabled plugin offers; `extension_point` is a plain string so a later one
 * adds rows rather than a migration, and the table is rewritten at every boot
 * because registration is pure. `plugin_kv` survives a disable, because
 * disabling is a toggle, and is wiped only by an explicit reset - which is why
 * the catalog is the only table a dropped plugin loses.
 *
 * The bounds are CHECK constraints because SQLite cannot add one later without
 * rebuilding the table.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE plugins (
      id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      config TEXT NOT NULL CHECK (json_valid(config)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE plugin_contributions (
      owner TEXT NOT NULL CHECK (length(owner) > 0),
      extension_point TEXT NOT NULL CHECK (length(extension_point) > 0),
      id TEXT NOT NULL CHECK (length(id) > 0),
      definition TEXT NOT NULL CHECK (json_valid(definition)),
      PRIMARY KEY (owner, extension_point, id)
    )
  `;

  yield* sql`
    CREATE TABLE plugin_kv (
      plugin_id TEXT NOT NULL CHECK (length(plugin_id) > 0),
      key TEXT NOT NULL CHECK (length(key) > 0),
      value TEXT NOT NULL CHECK (json_valid(value)),
      PRIMARY KEY (plugin_id, key)
    )
  `;
});
