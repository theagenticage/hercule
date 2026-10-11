/**
 * Subscriptions: the standing claims a holder has on events that have not
 * arrived. A session registers its own through three operations, and
 * `permission.request` opens one on the request it makes through
 * `permissionRequestSubscriptions`; a run opens one for each signal trigger of its
 * plan through `runHeldSubscriptions`.
 * `targets.ts` expands a target or an Event Selector into the expression the
 * event router evaluates, and only this domain calls it.
 *
 * `subscription.create` checks a run target through the `RunTargets` port,
 * which the controller daemon provides, because the runs domain depends on
 * this one and not the other way round.
 */
export { subscriptionRepository, type StoredSubscription } from "./repository";
export { permissionRequestSubscriptions } from "./permission-request-subscription";
export { runHeldSubscriptions } from "./run-held";
export { RunTargets } from "./run-targets";
export { buildHolderEndedReason, SubscriptionService, SubscriptionServiceLayer } from "./service";
