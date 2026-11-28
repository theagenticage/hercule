/**
 * Renames `runners.watermark` to `runners.metrics`.
 *
 * The column holds the runner's latest report of its free disk and available
 * memory, which is now called the Runner Metrics. "Watermark" now means only
 * the disk limit the controller holds, `disk_watermark_bytes`. The JSON
 * document in the column does not change.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE runners RENAME COLUMN watermark TO metrics`;
});
