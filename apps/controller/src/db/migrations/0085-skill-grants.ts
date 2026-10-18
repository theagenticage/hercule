/**
 * Adds the `skill` grants to the shipped `unrestricted` and `assistant`
 * profiles in a database that already has them.
 *
 * Seeding inserts a profile only if it is absent, so a profile seeded by an
 * earlier build never gains a grant added later. The two profiles get what a
 * new database seeds them with:
 *
 * - `unrestricted` gets `skill.read`. It holds every grant the user has
 *   except `skill.write` and `skill.apply`. It is the default profile of
 *   every Thread, so with those two any Thread that read a hostile README
 *   could change a skill that then steers every later Thread.
 * - `assistant` gets `skill.read` and `skill.write`, so an assistant can read
 *   the user's skills and propose a revision. It never gets `skill.apply`: its
 *   proposal waits for the user.
 * - `worker` gets nothing: a workflow step has no reason to read or change
 *   the user's skills.
 *
 * A profile the user made, or a shipped profile the user renamed and then
 * replaced with one of their own, is left as it is: adding a grant silently
 * would give a profile something its owner never chose. Each grant is added
 * only where it is missing, so running the migration again changes nothing.
 * The migration selects each profile by its name and `shipped = 1`, so a
 * custom profile named `unrestricted` is not widened.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { nowIso } from "../time";

/** The grants each shipped profile gains, by the profile's name. */
const ADDED_GRANTS: ReadonlyArray<readonly [profile: string, grant: string]> = [
  ["unrestricted", "skill.read"],
  ["assistant", "skill.read"],
  ["assistant", "skill.write"],
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* nowIso;

  for (const [profile, grant] of ADDED_GRANTS) {
    yield* sql`
      UPDATE permission_profiles
      SET grants = json_insert(grants, '$[#]', ${grant}), updated_at = ${at}
      WHERE name = ${profile}
        AND shipped = 1
        AND NOT EXISTS (
          SELECT 1 FROM json_each(permission_profiles.grants) WHERE value = ${grant}
        )
    `;
  }
});
