/**
 * Every input a session was ever given, one row each, and the two things a
 * session carries into the one that continues it.
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
      status TEXT NOT NULL CHECK (status IN ('queued', 'delivered', 'cancelled')),
      delivery TEXT CHECK (delivery IS NULL OR delivery IN ('opened', 'steered')),
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      -- Set while the frame is out and unanswered; null once answered or never
      -- sent. A row is waiting (queued, null), on the wire (queued, set),
      -- delivered or cancelled - one of four states, not three.
      sent_at TEXT,
      -- Why a delivery did not go through, in the runner's or the
      -- controller's own words: set on a row still queued (until it is sent
      -- again) or on one a failed delivery ended instead of resending.
      message TEXT
    )
  `;
  // The one walk there is: a session's own inputs, oldest first.
  yield* sql`CREATE INDEX session_inputs_session ON session_inputs (session_id, created_at, id)`;

  /**
   * The model the session runs under now, which is not what `spec` says:
   * `session.update` can change it mid-life, and `spec` is the frozen document
   * the runner was told at start. A resume or a fork reads this one.
   *
   * SQLite takes a NOT NULL column only with a default, so the empty document
   * is there for the ALTER alone; the UPDATE below fills every row that exists
   * and every insert since writes its own.
   */
  yield* sql`
    ALTER TABLE sessions ADD COLUMN model_selection TEXT NOT NULL DEFAULT '{}'
                                    CHECK (json_valid(model_selection))
  `;
  yield* sql`UPDATE sessions SET model_selection = json_extract(spec, '$.modelSelection')`;

  /**
   * Set only where the session was forked; a resume carries on the same
   * provider-native session and so has nothing to point at.
   */
  yield* sql`ALTER TABLE sessions ADD COLUMN parent_session_id BLOB`;
});
