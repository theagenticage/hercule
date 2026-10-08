/**
 * Restores `sessions.last_activity_at` for sessions that have exited.
 *
 * Until now every exit wrote its own time to `last_activity_at`. A runner
 * restart exits every live session within a second, so all of them ended up
 * with the same "last activity", whatever they had last done. From now on an
 * exit leaves the column alone and `exited_at` holds the exit time.
 *
 * For each exited session this sets the column to the time of its last real
 * event: the last row of its stream that is not a `session.exited` row and
 * that the final exit did not come before. Which rows came before the final
 * exit is decided in one of two ways:
 *
 * - The session's last life (from its last `session.started` row on) ends in
 *   a `session.exited` row. Then every row stored before that row counts, and
 *   a row stored after it is a stray event. Rows are compared by `position`,
 *   which the controller assigns when it stores them, because the clocks of
 *   the runner (`at`) and the controller (`exited_at`) can differ.
 * - The last life has no `session.exited` row, because the controller ended
 *   the session itself, for example when a reconnecting runner no longer held
 *   it. Stored order cannot tell a stray event from a real one here, so rows
 *   count when their `at` is not later than `exited_at`. That compares the
 *   runner's clock with the controller's, which is the best this case allows.
 *
 * A session with no row that counts, for example one that was queued and
 * ended before it ran, keeps the time it has.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    WITH last_start AS (
      SELECT session_id, MAX(position) AS position
      FROM session_stream
      WHERE json_extract(event, '$._tag') = 'session.started'
      GROUP BY session_id
    ),
    final_exit AS (
      SELECT stream.session_id, MAX(stream.position) AS position
      FROM session_stream stream
      LEFT JOIN last_start ON last_start.session_id = stream.session_id
      WHERE json_extract(stream.event, '$._tag') = 'session.exited'
        AND stream.position > COALESCE(last_start.position, 0)
      GROUP BY stream.session_id
    ),
    last_real_event AS (
      SELECT stream.session_id, MAX(stream.at) AS at
      FROM session_stream stream
      JOIN sessions ON sessions.id = stream.session_id
      LEFT JOIN final_exit ON final_exit.session_id = stream.session_id
      WHERE json_extract(stream.event, '$._tag') <> 'session.exited'
        AND CASE WHEN final_exit.position IS NOT NULL
                 THEN stream.position < final_exit.position
                 ELSE stream.at <= sessions.exited_at END
      GROUP BY stream.session_id
    )
    UPDATE sessions SET last_activity_at = last_real_event.at
    FROM last_real_event
    WHERE sessions.id = last_real_event.session_id
      AND sessions.status = 'exited'
      AND sessions.exited_at IS NOT NULL
  `;
});
