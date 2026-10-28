/**
 * Adds `sessions.tool_calls`: how many tool calls the session's agents made,
 * its own agent's and every subagent's. From now on the controller adds one
 * each time it stores an event that starts a tool call.
 *
 * The sessions that exist already get their count from their stored events:
 * every `item.started` row whose kind is a tool-call kind, whichever agent
 * reported it. Nothing deletes from `session_stream`, so the count is exact.
 *
 * The kinds are written out here rather than imported from `TOOL_CALL_KINDS`
 * in the sessions domain. A migration must do the same thing forever, and an
 * import would change what it counts the day someone edits that list. The
 * migration test checks that both lists match today.
 *
 * The counts are computed in one pass over the stream, grouped by session,
 * and then written only to the sessions that have any. A session with no tool
 * calls keeps the column's default, 0. Reading every event's JSON is the whole
 * cost: on a 1.8 GB database with 1,000 sessions and 1,000,000 stream rows the
 * backfill took about 5 seconds, and one count per session took the same or
 * up to a second longer.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The item kinds that counted as tool calls when this migration was written. */
export const MIGRATED_TOOL_CALL_KINDS = [
  "command_execution",
  "file_change",
  "file_read",
  "file_search",
  "tool_call",
  "web_search",
  "subagent",
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE sessions ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0
      CHECK (tool_calls >= 0)
  `;
  yield* sql`
    WITH counts AS (
      SELECT session_id, COUNT(*) AS tool_calls FROM session_stream
      WHERE json_extract(event, '$._tag') = 'item.started'
        AND json_extract(event, '$.kind') IN ${sql.in(MIGRATED_TOOL_CALL_KINDS)}
      GROUP BY session_id
    )
    UPDATE sessions SET tool_calls = counts.tool_calls
    FROM counts WHERE sessions.id = counts.session_id
  `;
});
