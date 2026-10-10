/**
 * Deletes every stored `topics.order` and `lastChecked.intake` user setting.
 *
 * Both keys belonged to the web app's Intake screen, which is gone, so the
 * contract no longer declares them. The settings store skips a stored key it
 * does not declare, but it logs a warning each time it reads one, and the
 * settings are read on every page load. Deleting the rows ends the warnings;
 * nothing reads either value any more, so nothing is lost.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DELETE FROM user_settings WHERE key IN ('topics.order', 'lastChecked.intake')`;
});
