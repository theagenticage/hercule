/**
 * Signals: what Intake puts in front of the user because a move is asked of
 * them, with the actions the user may take on each (spec 10 §9).
 */
export { findSignalInput } from "./actions";
export { truncateOutcome } from "./outcome";
export { SignalClaims, SignalClaimsLayer } from "./claims";
export { IgnoreRuleService, IgnoreRuleServiceLayer } from "./ignore-rules";
export { SignalRaises, SignalRaisesLayer } from "./raises";
export { signalRepository, type PendingRaise } from "./repository";
export { SignalService, SignalServiceLayer } from "./service";
