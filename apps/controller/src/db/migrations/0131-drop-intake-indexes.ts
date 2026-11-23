/**
 * Drops two indexes that only reads of Intake's removed screens used:
 *
 * - `task_provenance_handoff_run`, the partial index on `task_provenance
 *   (run_id, task_id)` for the handoff entries. Migration 90 added it for
 *   `task.queryLegs`, which found a handoff entry by the run it started. No
 *   other read looks a handoff entry up by its run. The `handedOff` filter of
 *   `task.query` reads `task_provenance_handoff` instead, the partial index on
 *   `(task_id, at)` that holds the same entries.
 * - `task_provenance_event`, the partial index on `task_provenance (event_id)`.
 *   Migration 72 added it so `event.query` could list the Tasks each event is
 *   on, and filter on that. Both went with Everything's "What came of it", and
 *   no other read looks provenance up by its event.
 *
 * It changes no row.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX task_provenance_handoff_run`;
  yield* sql`DROP INDEX task_provenance_event`;
});
