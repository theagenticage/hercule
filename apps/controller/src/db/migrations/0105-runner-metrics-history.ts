/**
 * Adds `runner_metrics`, the history of each runner's Runner Metrics: one row
 * per runner per minute.
 *
 * - `minute` is the start of the minute as Unix milliseconds, a multiple of
 *   60000. The primary key is `(runner_id, minute)` and the table is
 *   `WITHOUT ROWID`, so the key is the table itself and the only index. Every
 *   read is a range on it.
 * - The two CPU columns are null for a minute whose report had no CPU.
 * - A runner's rows go with the runner.
 *
 * It also adds `sessions_live_by_runner`. Each row records how many sessions
 * the runner held and had queued at that minute, counted once a minute per
 * runner. The older `sessions_running` index covers only the sessions that
 * hold a slot, so counting the queued ones as well would read all of the
 * runner's sessions, including every one that has exited. This index leaves
 * out the exited ones, so the count reads only the sessions still going.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE runner_metrics (
      runner_id BLOB NOT NULL REFERENCES runners (id) ON DELETE CASCADE,
      minute INTEGER NOT NULL,
      disk_free_bytes INTEGER NOT NULL,
      available_memory_bytes INTEGER NOT NULL,
      cpu_average_percent REAL,
      cpu_peak_percent REAL,
      sessions_running INTEGER NOT NULL,
      sessions_queued INTEGER NOT NULL,
      PRIMARY KEY (runner_id, minute)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX sessions_live_by_runner ON sessions (runner_id)
    WHERE status IN ('queued', 'starting', 'idle', 'busy')
  `;
});
