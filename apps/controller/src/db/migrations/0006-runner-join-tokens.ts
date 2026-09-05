/**
 * The join tokens: one row per invitation to enlist a machine.
 *
 * A join token is a bearer secret with one use in it, so only its hash is here,
 * as with every other token Hydra issues. The row carries an id of its own, so
 * the entry that records the mint and the entry that records the machine it
 * enlisted name the same invitation; the hash alone could not, because it is
 * the secret's shadow and never appears in the log.
 *
 * Spending a token is an update rather than a delete: `used_at IS NULL` is the
 * single-use guard, and it has to stay for as long as the token could be
 * presented again. The row itself is swept once the hour is up, so what
 * survives an invitation is the audit entry naming its id, not this table. A
 * presenter is never told which of unminted, spent and expired its token was -
 * that difference is a probe - so the timestamp is for the operator reading the
 * table, not for an answer.
 *
 * The bounds are CHECK constraints because SQLite cannot add one to a table
 * later: the alternative to writing them here is rebuilding the table.
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
  // How a presented token is looked up, and the reason two rows cannot share a
  // hash: spending one would otherwise be ambiguous.
  yield* sql`CREATE UNIQUE INDEX runner_join_tokens_hash ON runner_join_tokens (token_hash)`;
});
