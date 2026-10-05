/**
 * Steps the controller daemon runs once at boot, before any session is placed
 * on a runner.
 *
 * These steps live in the daemon rather than in a domain because they cross
 * two domains. The sessions domain knows nothing about subscriptions, and the
 * subscriptions domain knows nothing about inputs, so the step that uses both
 * belongs to the layer above them.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { nowIso, withTransaction } from "../db";
import { endStrandedInputs } from "../sessions";
import { subscriptionRepository } from "../subscriptions";

/**
 * Ends every input that was being delivered when the controller stopped (see
 * `endStrandedInputs`), and records a lost wake-up on the subscription of
 * each cancelled input that a subscription match wrote.
 *
 * Such a wake-up is lost for good. The input row holds a subscription and an
 * event, that pair can be written only once, so the event router can never
 * write it again. Without the record, nothing would show the loss, and a
 * session waiting on an event that has already passed would wait forever
 * without knowing why. The record clears when a later wake-up for the same
 * subscription is written.
 */
export const endStrandedInputsAndReportLostWakeUps: Effect.Effect<
  void,
  SqlError,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One transaction, because cancelling the input is what loses the wake-up.
  // If boot cancelled the rows and stopped before recording the loss, the
  // subscription holder would wait on an event nothing can deliver, and
  // nothing would show it.
  yield* withTransaction(
    sql,
    Effect.gen(function* () {
      const lost = yield* endStrandedInputs;
      if (lost.length === 0) return;
      const subscriptions = yield* subscriptionRepository;
      const at = yield* nowIso;
      for (const wakeUp of lost) {
        yield* subscriptions.recordLostWakeUp(wakeUp.subscriptionId, wakeUp.eventId, at);
      }
    }),
  );
});
