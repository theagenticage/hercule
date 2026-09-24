/**
 * Marks as `controller-error` the failed runs that an earlier engine wrote as
 * `step-failed` although no step of theirs failed.
 *
 * Before `controller-error` existed, a run the controller could not carry out
 * was failed as `step-failed`. When no step was current, the run had no failed
 * step; when the run failed before it started, it had no start time. A run
 * that failed at one of its steps always has both, so the reader requires both
 * for every reason but `controller-error`, and would fail on those older rows.
 * Such a run did fail for a reason of the controller's own, so the new reason
 * is also the true one. Step records need no change: the earlier engine wrote
 * every column a step record's status needs.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE runs SET failure_reason = 'controller-error'
    WHERE status = 'failed' AND failure_reason <> 'controller-error'
      AND (failed_step_id IS NULL OR started_at IS NULL)
  `;
});
