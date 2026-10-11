/**
 * Adds the indexes the run list needs for two of its filters.
 *
 * `activeSince` keeps the runs that had not ended before an instant, so
 * `finished_at` is NULL or at or after it. A workflow's timeline reads one
 * day as `{ workflowId, activeSince: dayStart, until: dayEnd }`. If the list
 * filtered with the `OR` the filter reads as, SQLite would choose
 * `runs_workflow` instead, because that index also returns the runs in the
 * list's order, and it would walk every run the workflow ever had. So the
 * list first collects the runs with no `finished_at`, and those that finished
 * at or after the instant, with two lookups on one of these indexes, and
 * applies the other filters and the sort to those runs only:
 *
 * - `runs_workflow_finished` serves a list of one workflow's runs, so a
 *   read costs as many runs as that workflow has live now or finished since
 *   the instant;
 * - `runs_finished` serves a list of the runs of every workflow.
 *
 * `status` filters the list on one status, newest first. The partial index
 * `runs_unfinished` cannot serve it, because SQLite cannot prove that a bound
 * status is `pending` or `running`, so the list scanned every run.
 * `runs_status` serves it in the list's order, for every status. It also
 * serves every query `runs_unfinished` served, which is therefore dropped.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE INDEX runs_workflow_finished ON runs (workflow_id, finished_at)`;
  yield* sql`CREATE INDEX runs_finished ON runs (finished_at)`;
  yield* sql`CREATE INDEX runs_status ON runs (status, created_at, id)`;
  yield* sql`DROP INDEX runs_unfinished`;
});
