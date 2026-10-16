/**
 * Adds what rotation and Scheduled Wakes store (spec 12 sections 5.2, 5.3,
 * 8.2 and 8.3):
 *
 * - `session_inputs` accepts the source `rotation`: the flush turn's input,
 *   which asks a session to record what is durable before it is stopped.
 * - `sessions.retired_at`: when a rotation retired the session. A rotation
 *   sets it when the rotation is asked for, so it is one write. A retired
 *   session is given only its flush and is never resumed. The conversation's
 *   next session takes over the input still waiting on it.
 * - `sessions.flush_sent_at`: when the controller sent the retired session
 *   its flush turn. It is set once and never cleared. The runner ends the
 *   session when that turn ends, so every turn after this time is the flush
 *   turn.
 * - `conversation_messages.wake` and `quiet`: the Scheduled Wake that opened
 *   a reply's turn, and whether the assistant chose to stay quiet in it.
 * - `assistants.heartbeat_next_at` and `heartbeat_next_zone`: the next time
 *   the heartbeat fires and the zone that time was computed in, as a cron
 *   trigger stores them. Both are null until the Scheduler first computes
 *   them, and are set back to null when the heartbeat changes.
 *
 * It also adds three indexes the new reads need:
 *
 * - `session_inputs_delivered`, partial over delivered inputs, serves "which
 *   input opened the session's latest turn" at every turn's end, and "has
 *   the session had a turn".
 * - `conversations_assistant` serves the Scheduler's per-assistant read of
 *   conversations. `conversations_web` covers only web conversations.
 * - `conversation_messages_owner`, partial over the owner's messages, serves
 *   "when did the owner last write in this conversation" for a heartbeat that
 *   targets the most recent conversation.
 *
 * SQLite cannot widen a check in place, so `session_inputs` is rebuilt with
 * `session_input_attachments` beside it, the same way the Discussions
 * migration rebuilt them. The rebuild copies every row unchanged.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE session_inputs_next (
      id BLOB PRIMARY KEY NOT NULL,
      session_id BLOB NOT NULL,
      source TEXT NOT NULL
        CHECK (source IN ('user', 'subscription', 'heartbeat', 'reminder', 'discussion',
                         'rotation')),
      actor TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'cancelled')),
      delivery TEXT CHECK (delivery IS NULL OR delivery IN ('opened', 'steered')),
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      sent_at TEXT,
      reason TEXT,
      subscription_id BLOB,
      event_id INTEGER CHECK ((subscription_id IS NULL) = (event_id IS NULL)),
      step_iteration INTEGER,
      CHECK (status <> 'sent' OR sent_at IS NOT NULL)
    )
  `;
  yield* sql`
    INSERT INTO session_inputs_next
      (id, session_id, source, actor, text, status, delivery, created_at, delivered_at,
       sent_at, reason, subscription_id, event_id, step_iteration)
    SELECT id, session_id, source, actor, text, status, delivery, created_at, delivered_at,
           sent_at, reason, subscription_id, event_id, step_iteration
    FROM session_inputs
  `;
  yield* sql`
    CREATE TABLE session_input_attachments_next (
      input_id BLOB NOT NULL REFERENCES session_inputs_next (id),
      attachment_id BLOB NOT NULL REFERENCES attachments (id),
      position INTEGER NOT NULL,
      PRIMARY KEY (input_id, position)
    )
  `;
  yield* sql`
    INSERT INTO session_input_attachments_next (input_id, attachment_id, position)
    SELECT input_id, attachment_id, position FROM session_input_attachments
  `;
  yield* sql`DROP TABLE session_input_attachments`;
  yield* sql`DROP TABLE session_inputs`;
  yield* sql`ALTER TABLE session_inputs_next RENAME TO session_inputs`;
  yield* sql`ALTER TABLE session_input_attachments_next RENAME TO session_input_attachments`;

  yield* sql`CREATE INDEX session_inputs_session ON session_inputs (session_id, created_at, id)`;
  yield* sql`
    CREATE UNIQUE INDEX session_inputs_match ON session_inputs (subscription_id, event_id)
    WHERE subscription_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX session_inputs_awaiting ON session_inputs (session_id)
    WHERE status = 'queued' AND sent_at IS NULL
  `;
  yield* sql`
    CREATE INDEX session_inputs_delivered ON session_inputs (session_id, delivered_at, id)
    WHERE status = 'delivered'
  `;
  yield* sql`
    CREATE INDEX session_inputs_event ON session_inputs (event_id) WHERE event_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX session_input_attachments_by_attachment
    ON session_input_attachments (attachment_id)
  `;

  yield* sql`CREATE INDEX conversations_assistant ON conversations (assistant_id)`;
  yield* sql`
    CREATE INDEX conversation_messages_owner ON conversation_messages (conversation_id, position)
    WHERE sender_role = 'owner'
  `;

  yield* sql`ALTER TABLE sessions ADD COLUMN retired_at TEXT`;
  yield* sql`ALTER TABLE sessions ADD COLUMN flush_sent_at TEXT`;

  yield* sql`
    ALTER TABLE conversation_messages ADD COLUMN wake TEXT
      CHECK (wake IS NULL OR wake IN ('heartbeat', 'reminder'))
  `;
  yield* sql`
    ALTER TABLE conversation_messages ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0
      CHECK (quiet IN (0, 1))
  `;

  yield* sql`ALTER TABLE assistants ADD COLUMN heartbeat_next_at TEXT`;
  yield* sql`ALTER TABLE assistants ADD COLUMN heartbeat_next_zone TEXT`;
});
