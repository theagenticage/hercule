/**
 * Adds the two tables of Account Usage (spec 06 section 18):
 *
 * - `account_usage_readings` holds the latest reading of each usage window of
 *   a Provider Account, and its credit reading. `reading` is the reading's
 *   identity: the window name (`five-hour`, `weekly`, `monthly`) or `credit`.
 *   `value` is the reading as JSON, decoded with the protocol's `UsageReading`
 *   schema, so a new kind of reading needs no migration. `taken_at` repeats
 *   the reading's time as a column, because the upsert compares it: an older
 *   reading never replaces a newer one. Timestamps are fixed-width UTC
 *   (`2026-10-31T10:00:00.000Z`), so comparing them as text compares them as
 *   instants.
 * - `account_usage_reads` holds, per account, what limits how often the
 *   controller reads usage actively: when the last active read was claimed,
 *   and the newest time at which a running session reported usage. It also
 *   holds when the readings were last cleared, because a key or token was
 *   replaced: a report from a session whose process started before then used
 *   the old credential and is dropped. It is kept apart from the readings so
 *   that replacing a key, which deletes the readings, does not reset the
 *   15-minute limit.
 *
 * Both tables are new and empty, so the migration rewrites no row.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE account_usage_readings (
      provider_account_id BLOB NOT NULL REFERENCES provider_accounts (id) ON DELETE CASCADE,
      reading TEXT NOT NULL CHECK (reading IN ('five-hour', 'weekly', 'monthly', 'credit')),
      source TEXT NOT NULL CHECK (source IN ('session', 'read')),
      taken_at TEXT NOT NULL,
      value TEXT NOT NULL CHECK (json_valid(value)),
      PRIMARY KEY (provider_account_id, reading)
    )
  `;
  yield* sql`
    CREATE TABLE account_usage_reads (
      provider_account_id BLOB PRIMARY KEY NOT NULL REFERENCES provider_accounts (id) ON DELETE CASCADE,
      read_started_at TEXT,
      reported_at TEXT,
      cleared_at TEXT
    )
  `;
});
