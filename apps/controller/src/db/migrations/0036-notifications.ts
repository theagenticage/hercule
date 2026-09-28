/**
 * Adds `notifications`: the core's one record of what the user should know or
 * decide (spec 10 §7.1).
 *
 * The producer, the subject, the actions and the resolution are JSON columns.
 * A notification is read and written whole, and nothing but the resolution
 * changes after creation, so a child table per list would add joins and buy
 * nothing. `event_id` is not a foreign key: the event log is pruned, and a
 * notification keeps the id of the event it was derived from.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE notifications (
      id BLOB PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      producer TEXT NOT NULL CHECK (json_valid(producer)),
      mute_key TEXT,
      subject TEXT NOT NULL CHECK (json_valid(subject)),
      event_id INTEGER,
      actions TEXT NOT NULL CHECK (json_valid(actions)),
      status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
      resolution TEXT CHECK (resolution IS NULL OR json_valid(resolution)),
      created_at TEXT NOT NULL,
      -- An open decision has no resolution yet.
      CHECK (status = 'resolved' OR resolution IS NULL),
      -- An informational notification is born resolved and is never resolved
      -- again. Its only resolution is "handled": an assistant covered what it
      -- reports, so it was recorded without being pushed (spec 10 §7.5).
      CHECK (actions <> '[]' OR (status = 'resolved' AND
                                 (resolution IS NULL OR resolution ->> 'kind' = 'handled')))
    )
  `;
  // Serves the notification list, newest first.
  yield* sql`CREATE INDEX notifications_created ON notifications (created_at, id)`;
  // Serves the lookup of the open decisions about a subject, which the core
  // runs when it removes that subject. Open decisions are few, so the partial
  // index keeps that lookup small however long the list grows.
  yield* sql`
    CREATE INDEX notifications_open ON notifications (created_at, id) WHERE status = 'open'
  `;
});
