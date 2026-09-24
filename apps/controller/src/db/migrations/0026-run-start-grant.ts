/**
 * Replaces the grants `workflow.run` and `workflow.submit` with `run.start` in
 * every permission profile.
 *
 * The two operations those grants allowed, one starting a run of a stored
 * workflow and one of a workflow sent with the request, became one operation,
 * `run.start`, with one grant. A profile that could start runs either way can
 * still start them, so a profile with either old grant gets the new one once,
 * and a profile with neither is left alone. That covers the shipped profiles
 * and the ones the user wrote alike: the user chose to let those profiles
 * start runs, and dropping the grant would take that away without telling
 * them.
 *
 * The old grants are no longer in the vocabulary, and a profile that still
 * held one would fail to decode.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { nowIso } from "../time";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const at = yield* nowIso;

  // The new grant goes where the first old one was, so the order of the rest
  // of the list stays as it was.
  yield* sql`
    UPDATE permission_profiles
    SET grants = (
          SELECT json_group_array(value) FROM (
            SELECT CASE WHEN value = 'workflow.run' OR value = 'workflow.submit'
                        THEN 'run.start' ELSE value END AS value,
                   MIN(key) AS first
            FROM json_each(permission_profiles.grants)
            GROUP BY 1
            ORDER BY first
          )
        ),
        updated_at = ${at}
    WHERE EXISTS (
      SELECT 1 FROM json_each(permission_profiles.grants)
      WHERE value IN ('workflow.run', 'workflow.submit')
    )
  `;
});
