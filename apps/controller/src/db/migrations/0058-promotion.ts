/**
 * Promotion tokens and the seal (spec 03 section 8).
 *
 * A promotion token lets one machine pull this controller's data once. Like a
 * join token, only its hash is stored, and spending it is an update rather
 * than a delete: `used_at IS NULL` is the single-use check.
 *
 * `sealed_state` holds at most one row. A controller with that row is sealed:
 * it refuses every API request and points its runners at `new_address`, with
 * `signature` proving the pointer came from this controller's identity. The
 * row names the token whose transfer sealed it, so a repeated switch request
 * with that token gets the same answer, and any other token gets a refusal.
 *
 * There is no table for the freeze between the transfer and the switch: it
 * lives in memory only, so a controller that restarts mid-promotion serves
 * again rather than staying read-only.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE promotion_tokens (
      id BLOB PRIMARY KEY NOT NULL,
      token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL CHECK (expires_at > created_at),
      used_at TEXT
    )
  `;
  // Two rows cannot share a hash, or spending the token would be ambiguous.
  yield* sql`CREATE UNIQUE INDEX promotion_tokens_hash ON promotion_tokens (token_hash)`;

  yield* sql`
    CREATE TABLE sealed_state (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
      token_id BLOB NOT NULL,
      sealed_at TEXT NOT NULL,
      new_address TEXT NOT NULL,
      signature BLOB NOT NULL
    )
  `;
});
