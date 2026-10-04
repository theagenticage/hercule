/**
 * Converts a stored subscription row into the `Subscription` the API returns.
 * `subscription.query` and `run.read` both return subscriptions, so they share
 * this one conversion.
 */
import type { Subscription, SubscriptionHealth } from "@hercule/contract";
import type { StoredSubscription } from "./repository";

/** Returns the subscription's health: `ok` unless an evaluation error is recorded. */
const readHealth = (stored: StoredSubscription): SubscriptionHealth =>
  stored.healthErrorMessage === null || stored.healthErrorAt === null
    ? { state: "ok" }
    : { state: "error", message: stored.healthErrorMessage, at: stored.healthErrorAt };

/** Returns the wake-up that a restart cancelled, or null if there is none. */
const readLostWakeUp = (stored: StoredSubscription): Subscription["lostWakeUp"] =>
  stored.lostWakeUpEventId === null || stored.lostWakeUpAt === null
    ? null
    : { eventId: stored.lostWakeUpEventId, at: stored.lostWakeUpAt };

/** Returns a stored subscription as the API returns it. */
export const composeRecord = (stored: StoredSubscription): Subscription => ({
  id: stored.id,
  target: stored.target,
  condition: stored.condition,
  holder: stored.holder,
  health: readHealth(stored),
  lostWakeUp: readLostWakeUp(stored),
  createdAt: stored.createdAt,
});
