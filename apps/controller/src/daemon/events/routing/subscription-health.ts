/**
 * How a routing table records a subscription whose condition, or another
 * expression the route evaluates, could not be evaluated. The session table
 * and the signal table both route to subscriptions, so they share it.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { nowIso } from "../../../db";
import { Notifier } from "../../../notifications";
import { subscriptionRepository } from "../../../subscriptions";

/**
 * Builds the function that records a failed evaluation on a subscription's
 * health, inside the caller's transaction. A failure that turns the health
 * from ok to error also raises one notification, in the same write, so the
 * user hears about a broken condition once and not once per event.
 */
export const buildSubscriptionFailureRecorder: Effect.Effect<
  (subscriptionId: string, message: string) => Effect.Effect<void, SqlError>,
  never,
  SqlClient.SqlClient | Notifier
> = Effect.gen(function* () {
  const subscriptions = yield* subscriptionRepository;
  const notifier = yield* Notifier;
  return (subscriptionId, message) =>
    Effect.gen(function* () {
      const began = yield* subscriptions.recordEvaluationFailure(
        subscriptionId,
        message,
        yield* nowIso,
      );
      if (!began) return;
      yield* notifier.createCoreNotification({
        kind: "core.subscription-condition-error",
        title: "A subscription's condition could not be evaluated",
        body: message,
        subject: [{ kind: "subscription", id: subscriptionId }],
      });
    });
});
