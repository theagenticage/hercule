/**
 * Adds `signal.read` and `signal.write` to the shipped `assistant`, `worker`
 * and `unrestricted` profiles in a database that already has them.
 *
 * Seeding inserts a profile only if it is absent, so a profile seeded by an
 * earlier build never gains a grant added later. The three profiles now hold
 * both grants:
 *
 * - an assistant and a worker raise signals and read them back;
 * - `unrestricted` holds every grant the user has.
 *
 * Each grant is added only where it is missing, so a profile that already has
 * one keeps its list as it is. The migration selects the profiles by
 * `shipped = 1`. Otherwise, if a user renamed a shipped profile and gave a
 * custom one its name, the custom one would be widened without them knowing.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { nowIso } from "../time";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* nowIso;

  for (const grant of ["signal.read", "signal.write"]) {
    yield* sql`
      UPDATE permission_profiles
      SET grants = json_insert(grants, '$[#]', ${grant}), updated_at = ${at}
      WHERE name IN ('assistant', 'worker', 'unrestricted')
        AND shipped = 1
        AND NOT EXISTS (
          SELECT 1 FROM json_each(permission_profiles.grants) WHERE value = ${grant}
        )
    `;
  }
});
