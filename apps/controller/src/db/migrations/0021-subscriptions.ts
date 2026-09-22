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
 * Two facts about a subscription can stand at the same time, and each has its
 * own pair of columns.
 *
 * The first pair is the health: whether the router can evaluate the condition.
 * It is written on the first evaluation that fails, refreshed while failures
 * continue, and taken off by the next evaluation that is clean. Both columns
 * are null while the condition works, so `ok` needs no state column and the
 * first failure is one conditional write (`WHERE health_error_message IS
 * NULL`) rather than a counter two writers could disagree about.
 *
 * The second pair is the last wake-up a restart cancelled: which event it
 * carried, and when the restart found it. It is written by the boot step and
 * taken off by the next wake-up this subscription produces.
 *
 * The two are two slots and not one, because they begin and end for different
 * reasons and neither may hide the other. A clean evaluation of any unrelated
 * event would wipe a lost wake-up seconds after a restart wrote it, and a
 * condition that fails would bury it; the holder would never read either fact
 * it needed.
 *
 * Each pair is kept whole by a check, because one column of a pair without the
 * other reads as neither fact.
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
      lost_wake_up_event_id INTEGER,
      lost_wake_up_at TEXT,
      created_at TEXT NOT NULL,
      ended_at TEXT,
      ended_reason TEXT,
      ended_actor TEXT,
      actor TEXT NOT NULL,
      CHECK ((health_error_message IS NULL) = (health_error_at IS NULL)),
      CHECK ((lost_wake_up_event_id IS NULL) = (lost_wake_up_at IS NULL))
    )
  `;

  // A listing answers one holder's live subscriptions, oldest first, which is
  // exactly what this index holds. The router's own read takes every live row
  // of the table and is not what the index is for.
  yield* sql`
    CREATE INDEX subscriptions_holder ON subscriptions (holder_kind, holder_id, created_at, id)
    WHERE ended_at IS NULL
  `;
});
