/**
 * Assistants, their conversations, and the user's one GitHub default.
 *
 * An assistant is an agent row plus an `assistants` row with the same id. The
 * `assistants` row holds only what an assistant has beyond an agent: its
 * heartbeat and rotation, as JSON, and its reply mode.
 *
 * `agents.kind` marks which agent rows belong to an assistant. The agents
 * domain reads it to keep its own operations off assistants, so it never has
 * to read the `assistants` table. Every agent that exists already is a plain
 * agent, which the column's default records.
 *
 * A conversation is one assistant's exchange in one channel container. The web
 * channel is the only channel so far, and it has no containers, so
 * `container_key` is null there, which a CHECK enforces. An assistant has at
 * most one web conversation, which the partial unique index enforces.
 *
 * Nothing here is a foreign key, for the reason migration 0010 gives: a
 * session an assistant ran is history, and it must outlive the assistant.
 *
 * The user setting `thread.githubConnectionId` becomes
 * `github.defaultConnectionId`, because the default GitHub account now serves
 * an assistant's conversation sessions as well as workspace-less Threads. The
 * value is carried over, so nobody loses the account they picked.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE agents ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent'
      CHECK (kind IN ('agent', 'assistant'))
  `;

  yield* sql`
    CREATE TABLE assistants (
      agent_id BLOB PRIMARY KEY NOT NULL,
      heartbeat TEXT NOT NULL CHECK (json_valid(heartbeat)),
      rotation TEXT NOT NULL CHECK (json_valid(rotation)),
      reply TEXT NOT NULL CHECK (reply IN ('turn-end', 'segments')),
      created_at TEXT NOT NULL
    )
  `;
  // The assistant list is oldest first.
  yield* sql`CREATE INDEX assistants_created ON assistants (created_at, agent_id)`;

  yield* sql`
    CREATE TABLE conversations (
      id BLOB PRIMARY KEY NOT NULL,
      assistant_id BLOB NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('web')),
      container_key TEXT,
      created_at TEXT NOT NULL,
      CHECK (channel <> 'web' OR container_key IS NULL)
    )
  `;
  yield* sql`CREATE UNIQUE INDEX conversations_web ON conversations (assistant_id)
             WHERE channel = 'web'`;
  // The conversation list is oldest first. A list filtered by assistant has no
  // index of its own, so it walks the conversations in created order and
  // checks each one's assistant. That is fine while there are few
  // conversations; an index on `assistant_id` can come when there are many.
  yield* sql`CREATE INDEX conversations_created ON conversations (created_at, id)`;

  yield* sql`
    UPDATE user_settings SET key = 'github.defaultConnectionId'
    WHERE key = 'thread.githubConnectionId'
  `;
});
