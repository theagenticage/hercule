/**
 * Adds `connection.use` to the shipped `assistant` profile in a database that
 * already has that profile.
 *
 * Seeding inserts a profile only if it is absent, so a profile seeded by an
 * earlier build never gains a grant added later. The assistant profile now
 * holds `connection.use` so an assistant can act through the user's
 * Connections as the user would.
 *
 * Only that profile changes, and only if it does not already have the grant:
 * the worker profile is meant to lack it, and a profile the user edited keeps
 * every other choice they made. The migration selects the profile by
 * `shipped = 1`. Otherwise, if a user renamed the shipped profile and called a
 * custom one `assistant`, the custom one would be widened without them
 * knowing.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { nowIso } from "../time";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* nowIso;

  yield* sql`
    UPDATE permission_profiles
    SET grants = json_insert(grants, '$[#]', 'connection.use'), updated_at = ${at}
    WHERE name = 'assistant'
      AND shipped = 1
      AND NOT EXISTS (
        SELECT 1 FROM json_each(permission_profiles.grants) WHERE value = 'connection.use'
      )
  `;
});
