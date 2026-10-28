/**
 * Adds `discussion.read` and `discussion.write` to the shipped `assistant`,
 * `worker` and `unrestricted` profiles in a database that already has them.
 *
 * Seeding inserts a profile only if it is absent, so a profile seeded by an
 * earlier build never gains a grant added later. The three profiles now hold
 * both grants:
 *
 * - a worker reads and posts in the Discussions of the repository it works on;
 * - an assistant holds them too, because a session may spawn from an Agent
 *   only when the Agent's profile grants nothing beyond its own, so without
 *   them an assistant could no longer spawn a worker Agent;
 * - `unrestricted` holds every grant the user has.
 *
 * A profile the user made is left as it is. Each grant is added only where it
 * is missing, so running the migration again changes nothing. The migration
 * selects the profiles by `shipped = 1` alone, whatever they are named now:
 * a shipped profile the user renamed still gets the grants, and a custom
 * profile that took a shipped profile's name does not.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { nowIso } from "../time";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* nowIso;

  for (const grant of ["discussion.read", "discussion.write"]) {
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
