/**
 * A connection is one row plus its rows in `secrets`, owner kind `connection`.
 * The credential references are read from there and never stored twice.
 *
 * `plugin_id` and `type` are plain strings, not foreign keys: a type is a
 * plugin contribution, so a connection outlives a build that drops its plugin -
 * and its credentials have to survive with it.
 *
 * `labels` and `config` are JSON documents. Nothing queries inside `config`,
 * and `labels[0]` - the default topic - is read by whoever reads the row.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE connections (
      id BLOB PRIMARY KEY NOT NULL,
      plugin_id TEXT NOT NULL,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('connected', 'needs-reauth', 'error', 'disabled')),
      status_detail TEXT,
      labels TEXT NOT NULL CHECK (json_valid(labels)),
      config TEXT NOT NULL CHECK (json_valid(config)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // Both listing filters, and the per-plugin scoping the runtime surface does.
  yield* sql`CREATE INDEX connections_by_type ON connections (type)`;
});
