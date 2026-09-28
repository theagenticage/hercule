/**
 * Subscriptions: the standing claims a session holds on events that have not
 * arrived. One table and three operations. `targets.ts` expands a target into
 * the expression the event router evaluates, and only this domain's service
 * calls it.
 */
export { subscriptionRepository, type StoredSubscription } from "./repository";
export { buildHolderEndedReason, SubscriptionService, SubscriptionServiceLayer } from "./service";
