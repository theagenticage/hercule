/**
 * Completes the running runs that an earlier engine left stranded: runs with
 * at least one step record and none of them pending or running.
 *
 * The earlier engine completed a run in a transaction of its own, after the
 * one that ended the run's last step record. A restart between the two left
 * the run `running` with nothing left to execute. Every step it reached had
 * already ended, and a failed or cancelled step record ends its run in the
 * same transaction, so such a run did complete. It is marked `completed`, at
 * the time its last step record finished. It has no output, because that
 * engine had no terminal steps.
 *
 * A running run with no step record at all is left alone. Starting a run
 * creates its entry step records in the same transaction, and every workflow
 * has at least one entry step, so such a run should not exist. If one does,
 * it never did anything, so calling it completed would be false. The run
 * engine fails it with `controller-error` when it next executes the run, and
 * logs why.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE runs
    SET status = 'completed',
        finished_at = (SELECT max(finished_at) FROM run_steps WHERE run_steps.run_id = runs.id)
    WHERE status = 'running'
      AND EXISTS (SELECT 1 FROM run_steps WHERE run_steps.run_id = runs.id)
      AND NOT EXISTS (
        SELECT 1 FROM run_steps
        WHERE run_steps.run_id = runs.id AND run_steps.status IN ('pending', 'running')
      )
  `;
});
