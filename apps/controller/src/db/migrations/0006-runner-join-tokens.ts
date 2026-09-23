/**
 * The join tokens: one row per invitation to enlist a machine.
 *
 * Only the hash is stored. The row has an id of its own so the audit entries
 * for creating the token and for enlisting with it can refer to the same
 * invitation. The hash cannot serve for that, because it never appears in the
 * log.
 *
 * Using a token is an update rather than a delete: `used_at IS NULL` is the
 * single-use check, and the row has to stay for as long as the token could be
 * presented again. The timestamp is for an operator reading the table, because
 * whoever presents a token is never told whether it was unknown, already used
 * or expired.
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
  // Two rows cannot share a hash, or using the token would be ambiguous.
  yield* sql`CREATE UNIQUE INDEX runner_join_tokens_hash ON runner_join_tokens (token_hash)`;
});
