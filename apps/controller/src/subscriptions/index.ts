/**
 * Subscriptions: the standing claims a session holds on events that have not
 * arrived. One table, three operations, and the expansion from a target to the
 * expression the matcher evaluates.
 */
export { EvaluationErrorNotifier, EvaluationErrorNotifierLayer } from "./evaluation-errors";
export { SubscriptionService, SubscriptionServiceLayer } from "./service";
export { expandTarget } from "./targets";
