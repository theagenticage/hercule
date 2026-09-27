/**
 * Adds `runs.original_run_id`: the run a re-run re-runs, set when
 * `run.rerun` starts a run and NULL for every other run. It is not a foreign
 * key, for the same reason `workflow_id` is not: a run row is history, and
 * keeps the id of the run it re-ran.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE runs ADD COLUMN original_run_id BLOB`;

  // Serves the run list filtered to the re-runs of one run, newest first,
  // which the run page reads to show what a run was re-run as. The index is
  // partial because most runs are not re-runs.
  yield* sql`
    CREATE INDEX runs_original_run_id ON runs (original_run_id, created_at, id)
    WHERE original_run_id IS NOT NULL
  `;
});
