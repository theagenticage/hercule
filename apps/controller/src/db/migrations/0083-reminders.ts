/**
 * Adds `reminders`: one-shot Scheduled Wakes, each owned by a conversation
 * (spec 12 section 8.3). A reminder belongs to the conversation and not to a
 * session, so a rotation leaves it where it is.
 *
 * `conversation_id` cascades, because deleting a conversation deletes what
 * was left to say in it. A reminder is never deleted otherwise: it moves from
 * `pending` to `fired` or `cancelled`, and the row stays as the record.
 * `fired_at` is set only when the status is `fired`. `cancelled_at` and
 * `cancelled_by` (the actor stamp of whoever cancelled it) are set only when
 * the status is `cancelled`.
 *
 * The indexes serve the reads. Each ends in `id` so a keyset page can resume:
 *
 * - `reminders_by_status` serves the Scheduler's "which pending reminders are
 *   due by now" on every tick, and `reminder.query` filtered by status. Fired
 *   and cancelled rows accumulate without bound, and a status prefix keeps
 *   the Scheduler's read away from them.
 * - `reminders_by_conversation` serves `reminder.query` for one conversation.
 * - `reminders_by_time` serves `reminder.query` with no filter.
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
      fired_at TEXT,
      cancelled_at TEXT,
      cancelled_by TEXT,
      CHECK ((status = 'fired') = (fired_at IS NOT NULL)),
      CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
      CHECK ((status = 'cancelled') = (cancelled_by IS NOT NULL))
    )
  `;
  yield* sql`CREATE INDEX reminders_by_status ON reminders (status, at, id)`;
  yield* sql`CREATE INDEX reminders_by_time ON reminders (at, id)`;
  yield* sql`CREATE INDEX reminders_by_conversation ON reminders (conversation_id, at, id)`;
});
