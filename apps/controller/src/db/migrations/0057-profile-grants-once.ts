/**
 * Removes repeated grants from every permission profile, keeping the first
 * time each grant appears.
 *
 * A profile either has a grant or not, so a repeat adds nothing, but until now
 * `profile.create` and `profile.update` stored a list with repeats as it was
 * sent. The contract now refuses such a list, in a request and in a response,
 * and a stored profile that still held a repeat would fail to decode. A
 * profile without a repeat is left alone.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { nowIso } from "../time";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* nowIso;

  // Each grant stays where it first appeared, so the order of the list stays
  // as it was.
  yield* sql`
    UPDATE permission_profiles
    SET grants = (
          SELECT json_group_array(value) FROM (
            SELECT value, MIN(key) AS first
            FROM json_each(permission_profiles.grants)
            GROUP BY value
            ORDER BY first
          )
        ),
        updated_at = ${at}
    WHERE (SELECT COUNT(*) FROM json_each(permission_profiles.grants))
        > (SELECT COUNT(DISTINCT value) FROM json_each(permission_profiles.grants))
  `;
});
