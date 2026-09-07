/**
 * Every input a session was ever given, one row each.
 *
 * A row exists before the input is sent anywhere, which is what gives the
 * operation an id to answer with, gives the actor stamp somewhere to live, and
 * lets an input the session cannot take yet wait until it can. The queue is the
 * rows still `queued`; `delivered` and `cancelled` are terminal.
 *
 * No foreign key, for the reason migration 0010 gives: a session is history and
 * outlives what it named.
 *
 * `source` carries the full vocabulary although only `user` is written today:
 * the bounds are CHECK constraints, which SQLite cannot widen without
 * rebuilding the table, and the other three sources are already spelled out in
 * the domain.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE session_inputs (
      id BLOB PRIMARY KEY NOT NULL,
      session_id BLOB NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('user', 'subscription', 'heartbeat', 'reminder')),
      actor TEXT NOT NULL,
      text TEXT NOT NULL,
      model_selection TEXT CHECK (model_selection IS NULL OR json_valid(model_selection)),
      status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'cancelled')),
      delivery TEXT CHECK (delivery IS NULL OR delivery IN ('opened', 'steered')),
      created_at TEXT NOT NULL,
      delivered_at TEXT
    )
  `;
  // The one walk there is: a session's own inputs, oldest first.
  yield* sql`CREATE INDEX session_inputs_session ON session_inputs (session_id, created_at, id)`;
});
