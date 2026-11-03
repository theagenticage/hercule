/**
 * Adds the disk usage a runner measures and reports (spec 03, section 6.9).
 *
 * On `workspaces`:
 *
 * - `size_bytes`, `frees_bytes` and `disk_usage_measured_at` are the latest
 *   successful measurement of the workspace. They are written together, so a
 *   check refuses a row with only some of them;
 * - `disk_usage_error` is why the newest attempt failed, and `NULL` when it
 *   succeeded or none was made. It is independent of the three columns above:
 *   a failed attempt leaves the earlier numbers in place.
 *
 * On `runners`, `repository_cache_bytes`, `harness_home_bytes` and
 * `disk_usage_measured_at` are what the runner uses outside its workspaces.
 * They are written together too.
 *
 * Every column is nullable and every existing row gets `NULL`: nothing was
 * measured before this migration, and the migration changes no row.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE workspaces ADD COLUMN size_bytes INTEGER`;
  yield* sql`
    ALTER TABLE workspaces ADD COLUMN frees_bytes INTEGER
      CHECK ((frees_bytes IS NULL) = (size_bytes IS NULL))
  `;
  yield* sql`
    ALTER TABLE workspaces ADD COLUMN disk_usage_measured_at TEXT
      CHECK ((disk_usage_measured_at IS NULL) = (size_bytes IS NULL))
  `;
  yield* sql`ALTER TABLE workspaces ADD COLUMN disk_usage_error TEXT`;

  yield* sql`ALTER TABLE runners ADD COLUMN repository_cache_bytes INTEGER`;
  yield* sql`
    ALTER TABLE runners ADD COLUMN harness_home_bytes INTEGER
      CHECK ((harness_home_bytes IS NULL) = (repository_cache_bytes IS NULL))
  `;
  yield* sql`
    ALTER TABLE runners ADD COLUMN disk_usage_measured_at TEXT
      CHECK ((disk_usage_measured_at IS NULL) = (repository_cache_bytes IS NULL))
  `;
});
