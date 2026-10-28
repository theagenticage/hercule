/**
 * Adds `wiki.read` and `wiki.write` to the shipped `assistant`, `worker` and
 * `unrestricted` profiles in a database that already has them.
 *
 * Seeding inserts a profile only if it is absent, so a profile seeded by an
 * earlier build never gains a grant added later. The three profiles now hold
 * both grants:
 *
 * - a worker and a Thread read their repository's Wiki and write to it;
 * - an assistant needs them to keep spawning worker Agents, because a session
 *   may spawn from an Agent only when the Agent's profile grants nothing
 *   beyond its own;
 * - `unrestricted` holds every grant the user has.
 *
 * Each grant is added only where it is missing, so a profile that already has
 * one keeps its list as it is. The migration selects the profiles by
 * `shipped = 1` alone, never by name: the three shipped profiles are the only
 * ones marked so and all three get both grants, a shipped profile the user
 * renamed included, while a profile the user made is never widened, whatever
 * its name.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { nowIso } from "../time";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* nowIso;

  for (const grant of ["wiki.read", "wiki.write"]) {
    yield* sql`
      UPDATE permission_profiles
      SET grants = json_insert(grants, '$[#]', ${grant}), updated_at = ${at}
      WHERE shipped = 1
        AND NOT EXISTS (
          SELECT 1 FROM json_each(permission_profiles.grants) WHERE value = ${grant}
        )
    `;
  }
});
