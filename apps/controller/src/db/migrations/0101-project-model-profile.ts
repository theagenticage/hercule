/**
 * Adds `projects.model_profile_id`: the Model Profile a new thread in the
 * project starts on (spec 06 section 17.9). It is NULL for a project that
 * names no profile, and then a new thread starts on the user's thread default.
 *
 * Deleting a profile clears the column in the application code, which also
 * records the change in the audit log. `ON DELETE SET NULL` is only a guard
 * against a dangling id.
 *
 * Every existing project starts with NULL. No row is rewritten.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE projects ADD COLUMN model_profile_id BLOB REFERENCES model_profiles (id) ON DELETE SET NULL`;
});
