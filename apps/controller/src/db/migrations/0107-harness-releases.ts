/**
 * Adds `harness_releases`, the newest release of each harness as the
 * controller last read it from the harness's publisher: one row per harness.
 *
 * - `harness_id` is the harness's qualified id. It names a plugin's
 *   contribution, which is not stored, so there is no foreign key. A row of a
 *   harness that is no longer registered stays and is never read.
 * - `version` is the version of the last successful read, and `NULL` while no
 *   read has succeeded.
 * - `checked_at` is when `version` was read, so it is `NULL` exactly when
 *   `version` is. A failed read leaves both as they were.
 * - `error` is why the most recent read failed, and `NULL` after a success.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE harness_releases (
      harness_id TEXT PRIMARY KEY,
      version TEXT,
      checked_at TEXT,
      error TEXT,
      CHECK ((version IS NULL) = (checked_at IS NULL))
    ) WITHOUT ROWID
  `;
});
