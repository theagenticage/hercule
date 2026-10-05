/**
 * Adds `run_steps.checkout_branch`: the branch a workspace action's step
 * switches the run's checkout to before its action runs.
 *
 * Only the run's first workspace step switches the branch: the one whose
 * start pinned the run to a runner, in a run on a repo's main workspace whose
 * workflow names a branch. After that step the branch belongs to the run's
 * agents, and no later step switches it back. The controller sends a running
 * step to its runner again on every connect, and the step it sends again
 * must switch exactly when the first one did. Which step pinned the run
 * cannot be read back from any other row, so the branch is stored on the
 * step's record when the step starts.
 *
 * The column is NULL for every other step record, and for every record
 * written before this migration.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE run_steps ADD COLUMN checkout_branch TEXT`;
});
