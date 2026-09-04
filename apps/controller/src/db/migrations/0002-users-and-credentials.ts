/**
 * The user and the credentials that speak for them: the user row, login bearer
 * tokens, and API keys (spec 13 section 4).
 *
 * Three things this migration keeps from 0001: 16-byte `BLOB` UUIDv7 primary
 * keys, ISO-8601 UTC timestamps with millisecond precision as `TEXT`, and no
 * absolute paths.
 *
 * Two things it establishes, and every later credential keeps:
 *
 * - **A credential is stored only as a hash.** Every token Hydra issues is
 *   opaque and 256 bits of randomness, so the hash is SHA-256 hex and lookup is
 *   one indexed equality (spec 13 section 4.1). The password is the other case
 *   and is stored as an argon2id PHC string, which carries its own parameters
 *   so raising them later leaves old hashes readable.
 * - **A credential is revoked, never deleted.** `revoked_at` keeps the row, so
 *   a token that was revoked cannot be re-issued by chance and the audit trail
 *   keeps its subject.
 *
 * v1 has exactly one user (spec 13 section 4.2), but every credential is keyed
 * by `user_id` from day one, so a second user is a `WHERE` clause rather than a
 * migration.
 *
 * It also carries one index that belongs to 0001's tables: the secrets listing
 * had no index for its own sort key. 0001 has shipped in development databases
 * and would not re-run, so the index is added here.
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

  // Password login hands back one of these (spec 13 section 4.2). The lifetime
  // is 30 days rolling: every authenticated use pushes `expires_at` out, so
  // `expires_at` is the whole expiry rule and no separate idle column exists.
  // `token_hash` is UNIQUE, which is also the index the request path looks
  // through - a second index on the same column would be dead weight.
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
  // identity (spec 13 section 4.3). `last_used_at` is null until the key is
  // first presented, which is what makes an unused key visible in Settings.
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
  // The listing is one user's keys in created order, paged by keyset on
  // `(created_at, id)` (spec 11 section 1.6), which is exactly this index.
  yield* sql`CREATE INDEX api_keys_user_created ON api_keys (user_id, created_at, id)`;

  // Not a credentials table, but the same omission: the unfiltered secrets
  // listing pages by keyset on `(name, id)` and 0001 gave it only
  // `(owner_kind, owner_id, name)`, so the default call - the one the CLI and
  // the web app make - was a full scan plus a temp b-tree for the ORDER BY.
  yield* sql`CREATE INDEX secrets_name ON secrets (name, id)`;
});
