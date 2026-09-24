/**
 * Agents, and the agent a session was spawned from.
 *
 * No column here is a foreign key, for the reason explained in migration 0010:
 * a session is history, and it must outlive the agent, the provider instance
 * and the permission profile it copied its values from. `sessions.agent_id` is
 * nullable because a null value means a Thread: a session nobody configured,
 * which a person drives by hand.
 *
 * `model_selection` holds the `{ model, options }` pair as JSON, or null for
 * an agent that runs on whatever its instance offers by default.
 * `disallowed_tools` holds the tool families as a JSON array, which is empty
 * when nothing is taken away.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE agents (
      id BLOB PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      instance_id BLOB NOT NULL,
      permission_profile_id BLOB NOT NULL,
      access_mode TEXT NOT NULL
        CHECK (access_mode IN ('approval-required', 'auto-accept-edits', 'auto', 'full-access')),
      model_selection TEXT CHECK (model_selection IS NULL OR json_valid(model_selection)),
      disallowed_tools TEXT NOT NULL CHECK (json_valid(disallowed_tools)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  // The only list: newest first, the same order as the session list.
  yield* sql`CREATE INDEX agents_created ON agents (created_at DESC, id DESC)`;

  yield* sql`ALTER TABLE sessions ADD COLUMN agent_id BLOB`;
  // Two reads use this index: the list of one agent's sessions, and the check
  // a delete makes to find out whether a session spawned from the agent is
  // still running.
  yield* sql`CREATE INDEX sessions_agent ON sessions (agent_id) WHERE agent_id IS NOT NULL`;
});
