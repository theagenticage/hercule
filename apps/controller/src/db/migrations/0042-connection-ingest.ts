/**
 * Adds what the ingest loops need from a Connection.
 *
 * - `connections.feed_intervals` holds the user's own poll interval for each
 *   feed of the Connection's event source, in seconds, keyed by feed name. A
 *   feed missing from it uses the interval its plugin declared, so every
 *   existing Connection starts with `{}`.
 * - `connection_state` is the plugin's state for one Connection: the cursors
 *   and snapshots an ingest handle keeps between polls. It is a table of its
 *   own, not a slice of `plugin_kv`, so that deleting a Connection deletes its
 *   state through the foreign key, without any code having to remember to.
 *   A Connection belongs to exactly one plugin, so its id alone scopes the
 *   rows.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE connections ADD COLUMN feed_intervals TEXT NOT NULL DEFAULT '{}'
      CHECK (json_valid(feed_intervals))
  `;
  yield* sql`
    CREATE TABLE connection_state (
      connection_id BLOB NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
      key TEXT NOT NULL CHECK (length(key) > 0),
      value TEXT NOT NULL CHECK (json_valid(value)),
      PRIMARY KEY (connection_id, key)
    )
  `;
});
