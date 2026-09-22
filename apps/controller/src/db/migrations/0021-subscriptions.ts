/**
 * Subscriptions: a holder's standing claim on events that have not arrived.
 *
 * The holder is a session today and a run later, so it is stored as a kind and
 * an id rather than as one column per kind. No column is a foreign key, for the
 * reason migration 0010 gives: a subscription outlives the process of the
 * session that made it, and the event router is what ends it when that session has
 * ended for good.
 *
 * `target` holds the target as the caller wrote it, as JSON, and `condition`
 * holds the expression it expanded into. Both are stored because they answer
 * different questions: the target is what a person reads, and the condition is
 * what the event router evaluates.
 *
 * Health is three nullable columns and no state column: all null is `ok`, so
 * the first failure of an evaluation error is one conditional write (`WHERE
 * health_error_kind IS NOT 'evaluation'`) instead of a counter that two
 * writers could disagree about. The check keeps the three whole, because one
 * column without the others would read as neither state.
 *
 * `health_error_kind` is there because the two errors a subscription can carry
 * have different lifetimes. An evaluation error is about the last event and is
 * taken off by the next event that evaluates cleanly. A lost wake-up is about
 * one event that will never be delivered again, and only a wake-up that does
 * arrive makes it out of date. Without the kind, a clean evaluation of any
 * unrelated event would wipe the lost wake-up seconds after a restart wrote
 * it, and the holder would never read it. The values are spelled as the API
 * spells them, so a row is read without a mapping.
 *
 * A subscription is live while `ended_at` is null. `ended_reason` says what
 * ended it - a cancellation, or the holder ending for good - and `ended_actor`
 * says who did, which for the sweep is the system and for a cancellation is
 * whoever called.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE subscriptions (
      id BLOB PRIMARY KEY NOT NULL,
      holder_kind TEXT NOT NULL,
      holder_id BLOB NOT NULL,
      target TEXT NOT NULL CHECK (json_valid(target)),
      condition TEXT NOT NULL,
      health_error_message TEXT,
      health_error_at TEXT,
      health_error_kind TEXT CHECK (health_error_kind IN ('evaluation', 'lost-wake-up')),
      created_at TEXT NOT NULL,
      ended_at TEXT,
      ended_reason TEXT,
      ended_actor TEXT,
      actor TEXT NOT NULL,
      CHECK ((health_error_message IS NULL) = (health_error_at IS NULL)
             AND (health_error_message IS NULL) = (health_error_kind IS NULL))
    )
  `;

  // Every read of this table reads live rows: one holder's, which this index
  // narrows, and the router's read of all of them, which walks the same index
  // rather than the table.
  yield* sql`
    CREATE INDEX subscriptions_holder ON subscriptions (holder_kind, holder_id, created_at, id)
    WHERE ended_at IS NULL
  `;
});
