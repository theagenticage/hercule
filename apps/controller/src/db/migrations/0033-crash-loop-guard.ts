/**
 * Adds the two columns of the crash-loop guard, the rule that keeps an exited
 * session from being resumed again and again for input it never gets to:
 *
 * - `sessions.turn_started_in_process`: 1 when the session's current process
 *   has started a turn, 0 when it has not. A start or a resume sets it back
 *   to 0, and the first `turn.started` of the new process sets it to 1.
 * - `sessions.awaiting_new_input`: 1 when the session's last exit came before
 *   its process started any turn, and no input has been stored for it since.
 *   An exit sets it from the first column, and a new input or a resume sets
 *   it back to 0.
 *
 * A session with `awaiting_new_input` set is not resumed automatically for the
 * inputs that were waiting when it exited: resuming it would most likely
 * start a process that exits the same way. The owner's next input lifts the
 * hold. A flag is used rather than a comparison of the input's creation time
 * with the exit time, because both can fall in the same millisecond.
 *
 * A session that exists already is backfilled from its stream. The rows of
 * its current process are the ones whose `runner_seq` is above
 * `stream_base`, because every sequence number of a process is stored with
 * the base of that process added to it.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE sessions ADD COLUMN turn_started_in_process INTEGER NOT NULL DEFAULT 0
      CHECK (turn_started_in_process IN (0, 1))
  `;
  yield* sql`
    ALTER TABLE sessions ADD COLUMN awaiting_new_input INTEGER NOT NULL DEFAULT 0
      CHECK (awaiting_new_input IN (0, 1))
  `;
  yield* sql`
    UPDATE sessions SET turn_started_in_process = 1
    WHERE EXISTS (
      SELECT 1 FROM session_stream
      WHERE session_stream.session_id = sessions.id
        AND session_stream.runner_seq > sessions.stream_base
        AND json_extract(session_stream.event, '$._tag') = 'turn.started'
    )
  `;
  yield* sql`
    UPDATE sessions SET awaiting_new_input = 1
    WHERE status = 'exited' AND turn_started_in_process = 0
  `;
});
