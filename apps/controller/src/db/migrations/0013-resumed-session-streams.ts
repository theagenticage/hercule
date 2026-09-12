/**
 * Where a session's current harness process started counting.
 *
 * A runner numbers a session's events per process, from zero, and the stream's
 * unique `(session_id, runner_seq)` is what makes a replayed frame harmless.
 * A session resumed in place is a second process under the same id, so its
 * numbers would collide with the first process's. The base is added to every
 * sequence the machine reports, and is raised to the stream's high-water mark
 * each time the session is resumed; zero until it ever is.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE sessions ADD COLUMN stream_base INTEGER NOT NULL DEFAULT 0`;
});
