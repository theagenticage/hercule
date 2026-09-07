/**
 * `provider_id` is a plain string, not a foreign key: providers live in the
 * plugin registry, so an instance outlives a build that drops its provider.
 *
 * `capability_snapshots` cascades off `runners`, and a `DROP TABLE` fires that
 * cascade: a later migration rebuilding `runners` must carry these rows across.
 *
 * `config` is a JSON document because only the provider's own schema knows what
 * is in it, and nothing here queries inside it.
 *
 * The bounds are CHECK constraints, which SQLite cannot add later without
 * rebuilding the table. The 128 is `MAX_PROVIDER_NAME_LENGTH` written out - a
 * landed migration is frozen, so raising it takes a migration of its own.
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
