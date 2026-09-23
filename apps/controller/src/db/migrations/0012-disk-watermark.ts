/**
 * The disk watermark override, stored the same way as
 * `max_concurrent_sessions`: a nullable column, where `NULL` means the default
 * of ten gibibytes. So a runner that never changed it needs no value.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE runners ADD COLUMN disk_watermark_bytes INTEGER
                                    CHECK (disk_watermark_bytes IS NULL OR disk_watermark_bytes >= 1)
  `;
});
