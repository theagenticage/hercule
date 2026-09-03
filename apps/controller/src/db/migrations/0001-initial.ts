/**
 * The tables the controller needs to boot for the first time: secrets,
 * permission profiles, settings, the controller identity, setup state, and the
 * event log.
 *
 * Conventions this migration establishes, and every later one keeps:
 *
 * - Every Hydra-owned entity has a 16-byte `BLOB` primary key holding a UUIDv7
 *   (spec 04, Truth model). The event log is the one exception: its id is the
 *   integer log position.
 * - **Timestamps are ISO-8601 strings in UTC** with millisecond precision
 *   (`2026-09-04T09:21:33.084Z`), which sort lexicographically, read plainly in
 *   a `sqlite3` shell, and carry their zone.
 * - Enumerations are `TEXT` with a `CHECK` constraint, so an unknown value is a
 *   write error rather than a row nobody can interpret.
 * - Nothing in the database holds an absolute path: the Data Root moves with a
 *   promotion (spec 04, Relocatable Data Root).
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Secret values, encrypted per value under the master key (spec 13 section
  // 2.1, ADR 0015). `owner_id` is text because it is polymorphic: the canonical
  // id string of a connection, plugin, runner or provider instance, or a fixed
  // name for the `core` owner. The owner and name are the AEAD associated data,
  // so renaming a secret is a re-encrypt, never an UPDATE of `name` alone.
  yield* sql`
    CREATE TABLE secrets (
      id BLOB PRIMARY KEY NOT NULL,
      owner_kind TEXT NOT NULL CHECK (
        owner_kind IN ('connection', 'plugin', 'runner', 'core', 'provider-instance')
      ),
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      nonce BLOB NOT NULL,
      ciphertext BLOB NOT NULL,
      created_at TEXT NOT NULL,
      rotated_at TEXT
    )
  `;
  yield* sql`CREATE UNIQUE INDEX secrets_owner_name ON secrets (owner_kind, owner_id, name)`;

  // Named grant bundles (spec 13 section 6). `grants` is a JSON array of
  // `family.verb` strings. The three shipped profiles carry `shipped = 1`: the
  // user may edit them but never delete them.
  yield* sql`
    CREATE TABLE permission_profiles (
      id BLOB PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      grants TEXT NOT NULL,
      shipped INTEGER NOT NULL DEFAULT 0 CHECK (shipped IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // Every setting that is not needed before the database opens (spec 04, What
  // is in the store). One table for both stores: `controller` rows are the
  // controller state settings, `user` rows the user settings store, which is
  // keyed by user id from day one and defaults lazily.
  yield* sql`
    CREATE TABLE settings (
      scope TEXT NOT NULL CHECK (scope IN ('controller', 'user')),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope, key)
    ) WITHOUT ROWID
  `;

  // The controller's stable identity, created at install and carried through a
  // promotion (ADR 0005). The private key is not here: it is a secrets row
  // under the `core` owner kind, encrypted like every other secret. The
  // `singleton` column is the primary key so a second row cannot be written.
  yield* sql`
    CREATE TABLE controller_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      id BLOB NOT NULL,
      public_key BLOB NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  // First-run state (spec 15 section 7). `token_hash` holds the single-use
  // setup token, hashed like every other token; it is null once setup completes
  // and while no token is outstanding. A fresh token is minted on every boot
  // until `completed_at` is set.
  yield* sql`
    CREATE TABLE setup_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      token_hash TEXT,
      completed_at TEXT
    )
  `;

  // The event log: one envelope per row (spec 08 section 2), and the system's
  // one integer id, which is also the log position consumers store as a cursor.
  // AUTOINCREMENT because TTL pruning deletes from the head of the table and a
  // reused rowid would hand a new event a position some cursor has passed.
  // `refs`, `payload` and `raw` are JSON text.
  yield* sql`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      connection_id BLOB,
      system TEXT NOT NULL,
      kind TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      dedup_key TEXT NOT NULL,
      refs TEXT NOT NULL DEFAULT '[]',
      url TEXT,
      payload TEXT NOT NULL,
      raw TEXT,
      actor TEXT
    )
  `;
  // A second emit with the same (connection, dedup key) is a no-op. Core
  // emitters have no connection, and SQLite treats NULLs as distinct in a
  // unique index, so the index keys on a stand-in blob instead.
  yield* sql`
    CREATE UNIQUE INDEX events_dedup
      ON events (ifnull(connection_id, x''), dedup_key)
  `;
  // The retention prune walks the log by arrival time.
  yield* sql`CREATE INDEX events_received_at ON events (received_at)`;
});
