/**
 * The disk watermark override, beside `max_concurrent_sessions` in shape: a
 * nullable column, `NULL` meaning the shipped ten gibibytes rather than a row
 * for every runner that has never touched it.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE runners ADD COLUMN disk_watermark_bytes INTEGER
                                    CHECK (disk_watermark_bytes IS NULL OR disk_watermark_bytes >= 0)
  `;
});
