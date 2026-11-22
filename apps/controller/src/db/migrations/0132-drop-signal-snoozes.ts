/**
 * Drops `signal_snoozes`, the table that held Intake's snoozes, and its index.
 *
 * Snoozing is gone with Intake's Later view. A signal that was snoozed when
 * the database is upgraded is open, so from then on it is on To do and its
 * thing is on the Inbox at once, whatever time its snooze named. Nothing else
 * of the signal changes: no signal row is written.
 *
 * `signals.priority_lowered` stays. A signal the user moved out of Now keeps
 * that mark, and a replacement raised on its thread still keeps the lower
 * priority.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Dropping the table drops its index with it.
  yield* sql`DROP TABLE signal_snoozes`;
});
