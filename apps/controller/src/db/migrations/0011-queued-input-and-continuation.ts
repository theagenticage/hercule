/**
 * Every input a session was ever given, one row each, and the two values a
 * session passes on to the session that continues it.
 *
 * A row is written before the input is sent anywhere, so:
 *
 * - the operation has an id to return;
 * - the actor stamp has somewhere to be stored;
 * - an input the session cannot take yet can wait until it can.
 *
 * The queue is the rows still `queued`; `delivered` and `cancelled` are final.
 *
 * No foreign key, for the reason explained in migration 0010: a session is
 * history and outlives what it refers to.
 *
 * `source` allows every value although only `user` is written today: the
 * bounds are CHECK constraints, which SQLite cannot widen without rebuilding
 * the table, and the other three sources are already defined in the domain.
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
      reason TEXT
    )
  `;
  // The only query: a session's own inputs, oldest first.
  yield* sql`CREATE INDEX session_inputs_session ON session_inputs (session_id, created_at, id)`;

  /**
   * The model the session runs with now, which can differ from the one in
   * `spec`: `session.update` can change it while the session runs, and `spec`
   * is the frozen document the runner received at start. A resume or a fork
   * reads this column.
   *
   * SQLite adds a NOT NULL column only with a default, so the empty document
   * is there only for the ALTER. The UPDATE below fills every existing row,
   * and every later insert writes its own value.
   */
  yield* sql`
    ALTER TABLE sessions ADD COLUMN model_selection TEXT NOT NULL DEFAULT '{}'
                                    CHECK (json_valid(model_selection))
  `;
  yield* sql`UPDATE sessions SET model_selection = json_extract(spec, '$.modelSelection')`;

  /**
   * Set only when the session was forked. A resume continues the same
   * provider-native session, so it has nothing to point at.
   */
  yield* sql`ALTER TABLE sessions ADD COLUMN parent_session_id BLOB`;
});
