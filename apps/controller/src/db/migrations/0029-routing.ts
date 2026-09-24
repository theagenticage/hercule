/**
 * Adds what a run needs to follow conditions, joins and loops:
 *
 * - `run_steps` allows the status `skipped`, for a step record whose step's
 *   condition was false when it would have started.
 * - `runs.failed_edge_index` holds the index in the plan's edges of the edge
 *   a run failed at: an edge whose condition could not be evaluated, or that
 *   had been followed as often as its `maxTraversals` allows.
 * - `runs.failure_message` holds what went wrong at that edge. A run that
 *   failed at a step keeps its message on the step record instead.
 * - `runs.output` holds a run's final output: the output of the terminal
 *   step that ended it.
 * - `run_edge_traversals` counts how many times a run has followed each edge
 *   of its plan, by the edge's index. An edge the run never followed has no
 *   row. The count is stored rather than worked out from the step records,
 *   because a step record does not say which edge created it. The counts of
 *   the runs that already exist are filled in (see below).
 *
 * SQLite cannot change a CHECK constraint, so `run_steps` is rebuilt. The
 * rowid is copied explicitly, because a run's step records are read in rowid
 * order, which is the order they were created in.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE run_steps_rebuilt (
      run_id BLOB NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      iteration INTEGER NOT NULL CHECK (iteration >= 1),
      status TEXT NOT NULL
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'skipped')),
      output TEXT CHECK (output IS NULL OR json_valid(output)),
      error TEXT CHECK (error IS NULL OR json_valid(error)),
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      PRIMARY KEY (run_id, step_id, iteration)
    )
  `;
  yield* sql`
    INSERT INTO run_steps_rebuilt (rowid, run_id, step_id, iteration, status, output, error,
                                   created_at, started_at, finished_at)
    SELECT rowid, run_id, step_id, iteration, status, output, error,
           created_at, started_at, finished_at
    FROM run_steps
  `;
  yield* sql`DROP TABLE run_steps`;
  yield* sql`ALTER TABLE run_steps_rebuilt RENAME TO run_steps`;

  yield* sql`ALTER TABLE runs ADD COLUMN failed_edge_index INTEGER`;
  yield* sql`ALTER TABLE runs ADD COLUMN failure_message TEXT`;
  yield* sql`ALTER TABLE runs ADD COLUMN output TEXT CHECK (output IS NULL OR json_valid(output))`;

  yield* sql`
    CREATE TABLE run_edge_traversals (
      run_id BLOB NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
      edge_index INTEGER NOT NULL CHECK (edge_index >= 0),
      count INTEGER NOT NULL CHECK (count >= 1),
      PRIMARY KEY (run_id, edge_index)
    )
  `;

  // A run from before this migration had no conditions, no caps, no loops,
  // and no step with more than one incoming edge. Such a run followed an
  // edge exactly once when the edge's source completed and the edge's target
  // has a step record, and never otherwise.
  yield* sql`
    INSERT INTO run_edge_traversals (run_id, edge_index, count)
    SELECT runs.id, CAST(edge.key AS INTEGER), 1
    FROM runs, json_each(runs.plan, '$.edges') AS edge
    WHERE EXISTS (
        SELECT 1 FROM run_steps
        WHERE run_steps.run_id = runs.id
          AND run_steps.step_id = json_extract(edge.value, '$.from')
          AND run_steps.status = 'completed'
      )
      AND EXISTS (
        SELECT 1 FROM run_steps
        WHERE run_steps.run_id = runs.id
          AND run_steps.step_id = json_extract(edge.value, '$.to')
      )
  `;
});
