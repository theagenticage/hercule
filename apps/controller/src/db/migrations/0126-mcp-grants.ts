/**
 * Adds the `mcp` grants to the shipped `unrestricted`, `worker` and
 * `assistant` profiles in a database that already has them.
 *
 * Seeding inserts a profile only if it is absent, so a profile seeded by an
 * earlier build never gains a grant added later. The three profiles get what
 * a new database seeds them with:
 *
 * - `unrestricted` gets `mcp.read` and `mcp.use`, by user parity. It never
 *   gets `mcp.manage`, a grant only the user gives: with it, a Thread that
 *   read a hostile README could add an MCP Server whose tool descriptions
 *   steer every thread that has it.
 * - `worker` gets `mcp.read` and `mcp.use`, so a workflow's agent step can
 *   call the tools of the servers on its thread.
 * - `assistant` gets `mcp.read`, so it can see which servers the user has.
 *
 * A profile the user made, or a shipped profile the user renamed and then
 * replaced with one of their own, is left as it is: adding a grant silently
 * would give a profile something its owner never chose. Each grant is added
 * only where it is missing, so running the migration again changes nothing.
 * The migration selects each profile by its name and `shipped = 1`, so a
 * custom profile named `worker` is not widened.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { nowIso } from "../time";

/** The grants each shipped profile gains, by the profile's name. */
const ADDED_GRANTS: ReadonlyArray<readonly [profile: string, grant: string]> = [
  ["unrestricted", "mcp.read"],
  ["unrestricted", "mcp.use"],
  ["worker", "mcp.read"],
  ["worker", "mcp.use"],
  ["assistant", "mcp.read"],
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
