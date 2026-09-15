/**
 * `event.audit` on the shipped `unrestricted` profile of a database that
 * already has one.
 *
 * Seeding is insert-if-absent, so a profile that was seeded by an earlier build
 * never gains a grant added later. `unrestricted` is the one profile whose
 * whole meaning is parity with the user, and a new verb that never reaches it
 * would quietly make it narrower than the user it mirrors.
 *
 * Only that profile, and only if it does not already hold the grant: the two
 * agent profiles are meant to lack it, and a profile the user edited keeps
 * every other choice they made in it. `shipped = 1` is what picks it out: a
 * user who renamed the shipped profile and called a custom one `unrestricted`
 * would otherwise have the custom one widened behind their back.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { nowIso } from "../time";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* nowIso;

  yield* sql`
    UPDATE permission_profiles
    SET grants = json_insert(grants, '$[#]', 'event.audit'), updated_at = ${at}
    WHERE name = 'unrestricted'
      AND shipped = 1
      AND NOT EXISTS (
        SELECT 1 FROM json_each(permission_profiles.grants) WHERE value = 'event.audit'
      )
  `;
});
