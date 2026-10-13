/**
 * Adds `thread.start` to the shipped `unrestricted` profile in a database that
 * already has it.
 *
 * Seeding inserts a profile only if it is absent, so a profile seeded by an
 * earlier build never gains a grant added later. `unrestricted` holds every
 * grant the user has, so it gets the new one. Nothing else does:
 *
 * - `assistant` and `worker` stay without it. A session on either profile
 *   could otherwise start a Thread, which runs with the user's own skills and
 *   hooks. The user opts a profile in under Settings > Permission profiles.
 * - A profile the user made, or a shipped profile the user renamed and then
 *   replaced with one of their own, is left as it is. The grant is new, and
 *   adding it silently would give a profile something its owner never chose.
 *
 * The grant is added only where it is missing, so running the migration again
 * changes nothing. The migration selects the profile by `shipped = 1`, for
 * the same reason as above: a custom profile named `unrestricted` is not the
 * shipped one.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { nowIso } from "../time";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* nowIso;

  yield* sql`
    UPDATE permission_profiles
    SET grants = json_insert(grants, '$[#]', 'thread.start'), updated_at = ${at}
    WHERE name = 'unrestricted'
      AND shipped = 1
      AND NOT EXISTS (
        SELECT 1 FROM json_each(permission_profiles.grants) WHERE value = 'thread.start'
      )
  `;
});
