/**
 * Stores a session's subagents: the agents its harness delegates work to
 * while it runs (spec 02, Subagent; spec 04, Truth model).
 *
 * - `session_stream.subagent_id` names the agent an event belongs to: NULL for
 *   the session's own agent, else the harness's id for the subagent. Every
 *   existing row was written before a harness could report a subagent, so it
 *   belongs to the session's own agent and stays NULL. The index lets one
 *   agent's transcript be read as a keyset walk over its own rows.
 * - `sessions.open_requests` replaces `sessions.open_request`. A session's own
 *   agent and its subagents can each be parked on a Request at the same time,
 *   so the row holds a JSON list, oldest first. A session that was parked on
 *   a Request keeps it as the list's only entry; it was asked by the
 *   session's own agent, so the entry has no `subagentId`.
 * - `sessions.usage` is the session's Token Usage over its whole life, and
 *   `sessions.usage_process` is the last snapshot the current process
 *   reported. A harness reports usage per process, so a resumed session's
 *   total is what earlier processes used plus the new process's snapshot.
 *   Both are NULL until the harness first reports usage.
 * - `session_subagents` holds one row per subagent, every field the
 *   `Subagent` record has, written as the session's events arrive so a list
 *   reads no stream. Deleting a session deletes its subagents.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE session_stream ADD COLUMN subagent_id TEXT`;
  yield* sql`
    CREATE INDEX session_stream_agent ON session_stream (session_id, subagent_id, position)
  `;

  yield* sql`
    ALTER TABLE sessions ADD COLUMN open_requests TEXT NOT NULL DEFAULT '[]'
      CHECK (json_valid(open_requests) AND json_type(open_requests) = 'array')
  `;
  yield* sql`
    UPDATE sessions SET open_requests = json_array(json(open_request))
    WHERE open_request IS NOT NULL
  `;
  yield* sql`ALTER TABLE sessions DROP COLUMN open_request`;

  yield* sql`
    ALTER TABLE sessions ADD COLUMN usage TEXT CHECK (usage IS NULL OR json_valid(usage))
  `;
  yield* sql`
    ALTER TABLE sessions ADD COLUMN usage_process TEXT
      CHECK (usage_process IS NULL OR json_valid(usage_process))
  `;

  yield* sql`
    CREATE TABLE session_subagents (
      session_id BLOB NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
      subagent_id TEXT NOT NULL CHECK (length(subagent_id) > 0),
      parent_subagent_id TEXT,
      item_id TEXT,
      description TEXT,
      agent_type TEXT,
      model TEXT,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'stopped')),
      tool_calls INTEGER NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
      activity TEXT,
      result TEXT,
      usage TEXT CHECK (usage IS NULL OR json_valid(usage)),
      usage_process TEXT CHECK (usage_process IS NULL OR json_valid(usage_process)),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      PRIMARY KEY (session_id, subagent_id)
    )
  `;
  yield* sql`
    CREATE INDEX session_subagents_started
      ON session_subagents (session_id, started_at, subagent_id)
  `;
});
