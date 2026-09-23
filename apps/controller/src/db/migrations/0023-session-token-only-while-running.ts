/**
 * A session row holds a token hash only while a process can hold the token:
 * while the session is `starting`, `idle` or `busy`.
 *
 * The rule is a CHECK constraint so that the database rejects a write that
 * breaks it. Every statement that moves a session out of those three statuses
 * must clear the hash in the same write. A future writer that forgets to clear
 * it fails at once, instead of leaving behind a credential that only the
 * status check rejects and that the unique index keeps for ever.
 *
 * SQLite cannot add a CHECK to a column that already exists, so the column is
 * renamed, added again with the constraint, and the hashes of the sessions
 * that are still running are copied across. A hash on any other row was
 * already unusable, and is dropped. In SQLite a column check can read the
 * whole row, which migration 0022 also relies on.
 *
 * The partial index holds only the running sessions, by runner. The sweep that
 * ends the sessions of lost runners reads exactly those rows once a minute,
 * and the index stays the size of the running work while the table grows for
 * ever.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX sessions_token_hash`;
  yield* sql`ALTER TABLE sessions RENAME COLUMN token_hash TO token_hash_unchecked`;
  yield* sql`
    ALTER TABLE sessions ADD COLUMN token_hash TEXT
    CHECK (token_hash IS NULL OR status IN ('starting', 'idle', 'busy'))
  `;
  yield* sql`
    UPDATE sessions SET token_hash = token_hash_unchecked
    WHERE status IN ('starting', 'idle', 'busy')
  `;
  yield* sql`ALTER TABLE sessions DROP COLUMN token_hash_unchecked`;
  yield* sql`CREATE UNIQUE INDEX sessions_token_hash ON sessions (token_hash)`;
  yield* sql`
    CREATE INDEX sessions_running ON sessions (runner_id)
    WHERE status IN ('starting', 'idle', 'busy')
  `;
});
