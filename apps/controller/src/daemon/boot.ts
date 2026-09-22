/**
 * What the controller daemon does once, at boot, before anything is placed on
 * a runner.
 *
 * A step is here rather than in a domain for the reason every use case in this
 * layer is here: it crosses two domains. The sessions domain knows nothing
 * about a subscription, and the subscriptions domain knows nothing about an
 * input, so the sequence that joins them is the layer above both.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { nowIso, withTransaction } from "../db";
import { cancelStrandedInputs } from "../sessions";
import { subscriptionRepository } from "../subscriptions";

/**
 * Ends every input a restart caught on the wire, and shows on the subscription
 * every wake-up that ended with one.
 *
 * A cancelled input a match wrote is a wake-up lost for good: the row names a
 * subscription and an event, that pair may be written only once, and no later
 * pass of the event router can write it again. Nothing else would ever say so,
 * and a session waiting on an event that has already gone by would wait for
 * ever without knowing why. It clears when a later wake-up for the same
 * subscription is written.
 */
export const cancelStrandedInputsAndReportLostWakeUps: Effect.Effect<
  void,
  SqlError,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One transaction, because the cancel is what loses the wake-up: a boot that
  // cancelled the rows and stopped before it wrote the health would leave a
  // holder waiting on an event nothing can deliver, with nothing saying so.
  yield* withTransaction(
    sql,
    Effect.gen(function* () {
      const lost = yield* cancelStrandedInputs;
      if (lost.length === 0) return;
      const subscriptions = yield* subscriptionRepository;
      const at = yield* nowIso;
      for (const wakeUp of lost) {
        yield* subscriptions.recordLostWakeUp(wakeUp.subscriptionId, wakeUp.eventId, at);
      }
    }),
  );
});
