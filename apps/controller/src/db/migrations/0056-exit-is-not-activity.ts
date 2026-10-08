/**
 * Restores `sessions.last_activity_at` for sessions that have exited.
 *
 * Until now every exit wrote its own time to `last_activity_at`. A runner
 * restart exits every live session within a second, so all of them ended up
 * with the same "last activity", whatever they had last done. From now on an
 * exit leaves the column alone and `exited_at` holds the exit time.
 *
 * For each exited session this sets the column to the time of the last event
 * in its stream that is neither the exit itself nor later than the last exit
 * (a stray event the runner reported after the exit is not activity). A session
 * with no such event, one that was queued and ended before it ran, keeps the
 * time it has. The stream holds the real times, so nothing is lost.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE sessions SET last_activity_at = (
      SELECT MAX(stream.at) FROM session_stream stream
      WHERE stream.session_id = sessions.id
        AND json_extract(stream.event, '$._tag') <> 'session.exited'
        AND stream.at <= sessions.exited_at
    )
    WHERE status = 'exited'
      AND exited_at IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM session_stream stream
        WHERE stream.session_id = sessions.id
          AND json_extract(stream.event, '$._tag') <> 'session.exited'
          AND stream.at <= sessions.exited_at
      )
  `;
});
