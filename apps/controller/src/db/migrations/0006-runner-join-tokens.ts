/**
 * The join tokens: one row per invitation to enlist a machine.
 *
 * Only the hash is stored. The row carries an id of its own so the mint entry
 * and the enlistment entry can name the same invitation, which the hash cannot
 * do because it never appears in the log.
 *
 * Spending is an update rather than a delete: `used_at IS NULL` is the
 * single-use guard, and it has to stand for as long as the token could be
 * presented again. Its timestamp is for an operator reading the table, since a
 * presenter is never told which of unminted, spent and expired its token was.
 *
 * The bounds are CHECK constraints because SQLite cannot add one later without
 * rebuilding the table.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE runner_join_tokens (
      id BLOB PRIMARY KEY NOT NULL,
      token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL CHECK (expires_at > created_at),
      used_at TEXT
    )
  `;
  // Two rows cannot share a hash: spending one would otherwise be ambiguous.
  yield* sql`CREATE UNIQUE INDEX runner_join_tokens_hash ON runner_join_tokens (token_hash)`;
});
