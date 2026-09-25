/**
 * Adds what a run needs to work in a workspace on a runner:
 *
 * - `runs.runner_id` and `runs.workspace_id`: the runner the run is pinned
 *   to and the run's workspace, both set when its first workspace step
 *   starts. They are not foreign keys, for the same reason `workflow_id` is
 *   not: a run row is history, and keeps the ids after the runner or the
 *   workspace is gone.
 * - `run_steps.input`: the params an action step's action was called with,
 *   rendered and checked against the action's input schema, as JSON. A
 *   workspace step sent to its runner again must carry exactly the input it
 *   was first sent with, not a new rendering of its templates.
 * - `checkouts.base_branch`: the branch a checkout's new branch was started
 *   from, or NULL for the resource's default branch. A provision sent to a
 *   runner again must be identical to the first one, so the value is kept
 *   rather than only passed through.
 * - `runs.keep_workspace`: whether the user who cancelled the run chose to
 *   keep its workspace for inspection. The workspace sweep reads it to decide
 *   whether a cancelled run's ephemeral workspace is deleted at once or kept
 *   like a failed run's. It is 0 for every run that was not cancelled.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE runs ADD COLUMN runner_id BLOB`;
  yield* sql`ALTER TABLE runs ADD COLUMN workspace_id BLOB`;
  yield* sql`ALTER TABLE run_steps ADD COLUMN input TEXT CHECK (input IS NULL OR json_valid(input))`;
  yield* sql`ALTER TABLE checkouts ADD COLUMN base_branch TEXT`;
  yield* sql`
    ALTER TABLE runs ADD COLUMN keep_workspace INTEGER NOT NULL DEFAULT 0
      CHECK (keep_workspace IN (0, 1))
  `;

  // Serves the workspace steps owed to a runner when it connects, which the
  // controller sends to it again:
  //
  //   SELECT ... FROM runs JOIN run_steps ON run_steps.run_id = runs.id
  //   WHERE runs.runner_id = ? AND runs.status = 'running'
  //     AND run_steps.status = 'running'
  //
  // The planner drives from `runs` through this index, and then reads each
  // run's few step records by the primary key of `run_steps`. The index is
  // partial because a run is pinned only while it is running, and the
  // finished runs, which keep their `runner_id` as history, would otherwise
  // make up almost all of it. The query must say `runs.status = 'running'`
  // for SQLite to use a partial index with this condition. The same index
  // serves retiring a runner, which fails the running runs pinned to it.
  yield* sql`
    CREATE INDEX runs_pinned_running ON runs (runner_id) WHERE status = 'running'
  `;

  // Finds the run whose workspace a workspace is. The workspace sweep reads
  // it for every ephemeral workspace it considers, and `workspace.dispose`
  // reads it before it removes one: what happens to a run's workspace depends
  // on how the run ended. The index is partial because most runs never have
  // a workspace.
  yield* sql`
    CREATE INDEX runs_workspace ON runs (workspace_id) WHERE workspace_id IS NOT NULL
  `;
});
