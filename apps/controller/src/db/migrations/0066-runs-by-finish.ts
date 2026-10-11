/**
 * Adds two indexes on `runs.finished_at`, which serve the run list filtered
 * with `activeSince`: the runs that had not ended before an instant, so
 * `finished_at` is NULL or at or after it. A workflow's timeline reads one
 * day as `{ workflowId, activeSince: dayStart, until: dayEnd }`. The run
 * list finds those runs with two lookups, one for each half of the filter;
 * its `list` says why.
 *
 * - `runs_workflow_finished` serves a list of one workflow's runs, so a read
 *   costs as many runs as that workflow has live now or finished since the
 *   instant.
 * - `runs_finished` serves a list of the runs of every workflow.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE INDEX runs_workflow_finished ON runs (workflow_id, finished_at)`;
  yield* sql`CREATE INDEX runs_finished ON runs (finished_at)`;
});
