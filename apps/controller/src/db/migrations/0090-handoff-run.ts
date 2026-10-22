/**
 * Adds a partial index on `task_provenance (run_id, task_id)` for the handoff
 * entries, the entries that name a signal.
 *
 * It serves `task.queryLegs`, which is given the run a handoff started and
 * the Task the run works on, and finds the handoff entry of that run. Without
 * it the read walks the Task's handoff entries one by one until it meets the
 * run, so its cost grows with the Task's history. With it, the read is one
 * probe of the index per run.
 *
 * `task_id` is in the index so the probe checks the Task without opening the
 * entry, and so a read of just the Tasks that have a handoff (the `handedOff`
 * filter of `task.query`) can be answered from either partial index alone.
 *
 * The index is partial because only handoff entries name a run that a client
 * asks about. It adds no column and changes no row.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX task_provenance_handoff_run ON task_provenance (run_id, task_id)
    WHERE signal_id IS NOT NULL
  `;
});
