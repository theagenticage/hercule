/**
 * Conversation messages, and the link from a session to the conversation it
 * answers.
 *
 * A conversation message is what the owner said, what the assistant
 * answered, or a notice that the assistant could not answer. `position`
 * numbers the messages of one conversation from 1, and the unique index keeps
 * two messages from taking the same place. The sender roles `trusted`,
 * `third-party` and `bot` arrive with channels other than the web app, by
 * widening the CHECK.
 *
 * `sessions.conversation_id` is the only link between a conversation and its
 * sessions. A conversation's current session is the newest session with its
 * id, so the index serves that read: newest by `created_at`, then by `id` for
 * two sessions created in the same millisecond. The index is partial because
 * most sessions answer no conversation. Every session that exists already is not
 * a conversation's, so the column is null for it.
 *
 * Nothing here is a foreign key, for the reason migration 0010 gives: a
 * session is history, and it must outlive the conversation it answered.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE conversation_messages (
      id BLOB PRIMARY KEY NOT NULL,
      conversation_id BLOB NOT NULL,
      container_key TEXT,
      position INTEGER NOT NULL,
      sender_role TEXT NOT NULL CHECK (sender_role IN ('owner', 'assistant', 'notice')),
      sender_label TEXT NOT NULL,
      text TEXT NOT NULL,
      session_id BLOB,
      turn_id TEXT,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE UNIQUE INDEX conversation_messages_position
             ON conversation_messages (conversation_id, position)`;

  yield* sql`ALTER TABLE sessions ADD COLUMN conversation_id BLOB`;
  yield* sql`CREATE INDEX sessions_conversation ON sessions (conversation_id, created_at, id)
             WHERE conversation_id IS NOT NULL`;
});
