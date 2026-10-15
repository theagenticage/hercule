/**
 * Adds `reminders`: one-shot Scheduled Wakes, each owned by a conversation
 * (spec 12 section 8.3). A reminder belongs to the conversation and not to a
 * session, so a rotation leaves it where it is.
 *
 * `conversation_id` cascades, because deleting a conversation deletes what
 * was left to say in it. A reminder is never deleted otherwise: it moves from
 * `pending` to `fired` or `cancelled`, and the row stays as the record.
 * `fired_at` is set only when the status is `fired`.
 *
 * The two indexes serve the two reads:
 *
 * - `reminders_due` is partial, over the pending reminders only. The Scheduler
 *   asks "which pending reminders are due by now" on every tick, and fired and
 *   cancelled rows accumulate without bound.
 * - `reminders_by_conversation` serves `reminder.query`, which lists one
 *   conversation's reminders by time.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE reminders (
      id BLOB PRIMARY KEY,
      conversation_id BLOB NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
      at TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'fired', 'cancelled')),
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL,
      fired_at TEXT
    )
  `;
  yield* sql`CREATE INDEX reminders_due ON reminders (at, id) WHERE status = 'pending'`;
  yield* sql`CREATE INDEX reminders_by_conversation ON reminders (conversation_id, at, id)`;
});
