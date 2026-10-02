/**
 * Lets a pending token flow store only what it will use, in both setup
 * tables, `oauth_setups` and `device_setups`.
 *
 * A flow either creates a connection or reconnects one, and the two need
 * different columns:
 *
 * - A flow that creates a connection may have no label yet. When the user
 *   gives none, the label is the account name, which is known only once the
 *   provider hands over tokens and the type's `validate` runs. So `label`
 *   becomes nullable. `labels` and `config` stay required: they default to no
 *   topic and no config when the flow starts.
 * - A reconnect keeps the connection's own label, topics and config, so it
 *   stores none of the three. Before this migration, a reconnect row held
 *   copies that nothing ever read back.
 *
 * A table CHECK holds both rules, so a row is one kind or the other and never
 * a mix. Every other column and constraint is unchanged.
 *
 * Each table is rebuilt rather than altered, because SQLite cannot relax a
 * NOT NULL in place. The rows of flows still in progress are copied across,
 * so a user who is signing in during an upgrade can still finish. A reconnect
 * row loses its copies of the label, topics and config, which the flow never
 * used.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE oauth_setups_new (
      state TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL,
      connection_id BLOB,
      label TEXT,
      labels TEXT CHECK (labels IS NULL OR json_valid(labels)),
      config TEXT CHECK (config IS NULL OR json_valid(config)),
      origin TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK (
        (connection_id IS NULL AND labels IS NOT NULL AND config IS NOT NULL)
        OR (connection_id IS NOT NULL AND label IS NULL AND labels IS NULL AND config IS NULL)
      )
    )
  `;
  yield* sql`
    INSERT INTO oauth_setups_new
      (state, type, connection_id, label, labels, config, origin, code_verifier,
       expires_at, created_at)
    SELECT
      state, type, connection_id,
      CASE WHEN connection_id IS NULL THEN label END,
      CASE WHEN connection_id IS NULL THEN labels END,
      CASE WHEN connection_id IS NULL THEN config END,
      origin, code_verifier, expires_at, created_at
    FROM oauth_setups
  `;
  yield* sql`DROP TABLE oauth_setups`;
  yield* sql`ALTER TABLE oauth_setups_new RENAME TO oauth_setups`;

  yield* sql`
    CREATE TABLE device_setups_new (
      setup_id TEXT PRIMARY KEY NOT NULL,
      type TEXT NOT NULL,
      connection_id BLOB,
      label TEXT,
      labels TEXT CHECK (labels IS NULL OR json_valid(labels)),
      config TEXT CHECK (config IS NULL OR json_valid(config)),
      device_code TEXT NOT NULL,
      interval_seconds INTEGER NOT NULL CHECK (interval_seconds > 0),
      next_poll_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK (
        (connection_id IS NULL AND labels IS NOT NULL AND config IS NOT NULL)
        OR (connection_id IS NOT NULL AND label IS NULL AND labels IS NULL AND config IS NULL)
      )
    )
  `;
  yield* sql`
    INSERT INTO device_setups_new
      (setup_id, type, connection_id, label, labels, config, device_code,
       interval_seconds, next_poll_at, expires_at, created_at)
    SELECT
      setup_id, type, connection_id,
      CASE WHEN connection_id IS NULL THEN label END,
      CASE WHEN connection_id IS NULL THEN labels END,
      CASE WHEN connection_id IS NULL THEN config END,
      device_code, interval_seconds, next_poll_at, expires_at, created_at
    FROM device_setups
  `;
  yield* sql`DROP TABLE device_setups`;
  yield* sql`ALTER TABLE device_setups_new RENAME TO device_setups`;
});
