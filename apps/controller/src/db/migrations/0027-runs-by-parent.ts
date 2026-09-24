/**
 * Indexes runs by the run whose step started them.
 *
 * A run that a `run.start` step starts holds its parent's id in its `origin`
 * JSON. Cancelling a run cancels every run it started, and the runs those
 * started, so the controller looks up a run's children by that id, one level
 * at a time. Without the index each level would read every run.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE INDEX runs_parent ON runs (json_extract(origin, '$.parentRunId'))`;
});
