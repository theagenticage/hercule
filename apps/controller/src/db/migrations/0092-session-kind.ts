/**
 * Adds `sessions.kind`: what the session is, one of `thread`, `run`,
 * `assistant` or `agent`. SQLite computes it from `agent_id`, `run_id` and
 * `conversation_id` when a row is read, so it is never stored and can never
 * disagree with them:
 *
 * - `thread` when no Agent is behind the session (`agent_id IS NULL`). This
 *   comes first, so a Thread that a run's step or an assistant started stays
 *   a `thread`;
 * - `run` when a run's agent step started it (`run_id` is set);
 * - `assistant` when it answers an assistant's conversation (`conversation_id`
 *   is set);
 * - `agent` for any other Agent session.
 *
 * The index serves the session list filtered by `kind`, sorted newest first.
 *
 * The migration rewrites no row. SQLite allows `ADD COLUMN` only for a
 * `VIRTUAL` generated column, not a `STORED` one.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE sessions ADD COLUMN kind TEXT GENERATED ALWAYS AS (
      CASE
        WHEN agent_id IS NULL THEN 'thread'
        WHEN run_id IS NOT NULL THEN 'run'
        WHEN conversation_id IS NOT NULL THEN 'assistant'
        ELSE 'agent'
      END
    ) VIRTUAL
  `;
  yield* sql`CREATE INDEX sessions_kind ON sessions (kind, created_at, id)`;
});
