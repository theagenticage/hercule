/**
 * Creates the `runs` table, and the `run_steps` table with one row per step
 * record: one attempt at one step of a run.
 *
 * These rows are the only record of a run. The controller keeps no run state
 * in memory that it cannot rebuild from them, so a run interrupted by a
 * restart continues from its rows at the next boot.
 *
 * `plan` is the workflow definition as it was when the run started, stored as
 * JSON. A run never reads its workflow again, so editing or deleting the
 * workflow does not change what a run does or how it is shown. For the same
 * reason `workflow_id` is not a foreign key: a run keeps the id of a workflow
 * that has since been deleted. It is null for a run of a workflow that was
 * never stored.
 *
 * `inputs` holds the resolved inputs, with defaults applied. `origin` holds
 * how the run was started, as JSON, because each kind of start carries
 * different fields.
 *
 * A step record's primary key is the run, the step id from the plan, and the
 * iteration, which counts from 1 for each step. The rowid orders a run's step
 * records in the order they were created.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE runs (
      id BLOB PRIMARY KEY NOT NULL,
      workflow_id BLOB,
      plan TEXT NOT NULL CHECK (json_valid(plan)),
      inputs TEXT NOT NULL CHECK (json_valid(inputs)),
      origin TEXT NOT NULL CHECK (json_valid(origin)),
      status TEXT NOT NULL
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
      failure_reason TEXT,
      failed_step_id TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
      CHECK ((status IN ('completed', 'failed', 'cancelled')) = (finished_at IS NOT NULL))
    )
  `;
  // Serves the run list, newest first.
  yield* sql`CREATE INDEX runs_created ON runs (created_at, id)`;
  // Serves the run list of one workflow, and the check for unfinished runs of
  // a workflow before it is deleted.
  yield* sql`CREATE INDEX runs_workflow ON runs (workflow_id, created_at, id)`;
  // Serves the boot, which resumes every unfinished run.
  yield* sql`CREATE INDEX runs_unfinished ON runs (status) WHERE status IN ('pending', 'running')`;

  yield* sql`
    CREATE TABLE run_steps (
      run_id BLOB NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      iteration INTEGER NOT NULL CHECK (iteration >= 1),
      status TEXT NOT NULL
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
      output TEXT CHECK (output IS NULL OR json_valid(output)),
      error TEXT CHECK (error IS NULL OR json_valid(error)),
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      PRIMARY KEY (run_id, step_id, iteration)
    )
  `;
});
