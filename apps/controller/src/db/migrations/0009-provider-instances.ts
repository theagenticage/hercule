/**
 * Provider instances and what the fleet reports about them.
 *
 * `config` is a JSON document because only the provider's own schema knows what
 * is in it; nothing here queries inside it. The provider id is a plain string
 * rather than a foreign key: providers live in the binary's plugin registry,
 * not in a table, and an instance whose provider a later build drops keeps its
 * row rather than losing the config a downgrade would want back.
 *
 * A snapshot is one row per instance x runner, because harness versions, logins
 * and model catalogues differ per machine. It is a cache of what a runner last
 * said, so it goes when either side of the pair does. Foreign keys are on for
 * every connection, and SQLite fires a cascade on the implicit delete a
 * `DROP TABLE` performs: a later migration rebuilding `runners` the way 0008 did
 * has to carry these rows across or accept losing the fleet's probe cache.
 *
 * The bounds are CHECK constraints because SQLite cannot add one later without
 * rebuilding the table. The 128 is `MAX_PROVIDER_NAME_LENGTH`, written out
 * because a landed migration is frozen while a constant is not: raising it takes
 * a migration of its own.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE provider_instances (
      id BLOB PRIMARY KEY NOT NULL,
      provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
      name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
      config TEXT NOT NULL CHECK (json_valid(config)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE capability_snapshots (
      instance_id BLOB NOT NULL REFERENCES provider_instances (id) ON DELETE CASCADE,
      runner_id BLOB NOT NULL REFERENCES runners (id) ON DELETE CASCADE,
      probed_at TEXT NOT NULL,
      harness_version TEXT,
      auth_status TEXT NOT NULL CHECK (auth_status IN ('ok', 'unauthenticated', 'error')),
      auth_identity TEXT,
      auth_plan_label TEXT,
      auth_backend TEXT,
      auth_message TEXT,
      models TEXT NOT NULL CHECK (json_valid(models)),
      PRIMARY KEY (instance_id, runner_id)
    )
  `;
});
