/**
 * The user and the credentials that authenticate them: the user row, login
 * bearer tokens, and API keys.
 *
 * Three things this migration keeps from 0001: 16-byte `BLOB` UUIDv7 primary
 * keys, ISO-8601 UTC timestamps with millisecond precision as `TEXT`, and no
 * absolute paths.
 *
 * Two things it establishes, and every later credential keeps:
 *
 * - **A credential is stored only as a hash.** Every token Hercule issues is
 *   opaque and 256 bits of randomness, so the hash is SHA-256 hex and lookup is
 *   one indexed equality. The password is the exception: it is stored as an
 *   argon2id PHC string, which includes its own parameters, so raising them
 *   later leaves old hashes readable.
 * - **A credential is revoked, never deleted.** `revoked_at` keeps the row, so
 *   a token that was revoked cannot be re-issued by chance and the audit trail
 *   keeps its subject.
 *
 * v1 has exactly one user, but every credential is keyed
 * by `user_id` from day one, so a second user is a `WHERE` clause rather than a
 * migration.
 *
 * It also fixes two things that belong to 0001's tables. The secrets list had
 * no index for its own sort key, and the user settings store had no user
 * column at all. 0001 has already run on development databases and would not
 * run again, so both are fixed here.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The user. `password_hash` is an argon2id PHC string
  // (`$argon2id$v=19$m=...,t=...,p=...$<salt>$<hash>`), never a bare digest:
  // the parameters and the salt travel with it.
  yield* sql`
    CREATE TABLE users (
      id BLOB PRIMARY KEY NOT NULL,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // Password login returns one of these. The lifetime is 30 days rolling:
  // every authenticated use moves `expires_at` later, so `expires_at` is the
  // whole expiry rule and there is no separate idle column. `token_hash` is
  // UNIQUE, which also creates the index each request looks up by, so a second
  // index on the same column would be useless.
  yield* sql`
    CREATE TABLE login_tokens (
      id BLOB PRIMARY KEY NOT NULL,
      user_id BLOB NOT NULL REFERENCES users (id),
      token_hash TEXT NOT NULL UNIQUE,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      revoked_at TEXT
    )
  `;

  // Long-lived, named, individually revocable, and always the user's own
  // identity. `last_used_at` is null until the key is first presented, which is
  // what makes an unused key visible in Settings.
  yield* sql`
    CREATE TABLE api_keys (
      id BLOB PRIMARY KEY NOT NULL,
      user_id BLOB NOT NULL REFERENCES users (id),
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    )
  `;
  // The list is one user's keys in creation order, paged by keyset on
  // `(created_at, id)`, which is exactly this index.
  yield* sql`CREATE INDEX api_keys_user_created ON api_keys (user_id, created_at, id)`;

  // Not a credentials table, but the same kind of gap: the unfiltered secrets
  // list pages by keyset on `(name, id)`, and 0001 created only an index on
  // `(owner_kind, owner_id, name)`. So the default call, the one the CLI and
  // the web app make, was a full scan plus a temporary b-tree for the ORDER BY.
  yield* sql`CREATE INDEX secrets_name ON secrets (name, id)`;

  // The user settings store. Keyed by user id from day one, so a second user is
  // a `WHERE` clause rather than a table rebuild that has to guess which user
  // owned each row. 0001's `settings` table allowed a `user` scope and nothing
  // ever wrote one; from here it holds the controller scope alone, and its
  // unused `scope` value is left in place because 0001 has shipped.
  yield* sql`
    CREATE TABLE user_settings (
      user_id BLOB NOT NULL REFERENCES users (id),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    ) WITHOUT ROWID
  `;
});
