/**
 * Signals: what Intake puts in front of the user because a move is asked of
 * them, with the actions the user may take on each (spec 10 §9).
 */
export { truncateOutcome } from "./outcome";
export { SignalClaims, SignalClaimsLayer } from "./claims";
export { findTaskToContinue, readThreadRef, SignalHandoffs, SignalHandoffsLayer } from "./handoffs";
export { IgnoreRuleService, IgnoreRuleServiceLayer } from "./ignore-rules";
export { SignalRaises, SignalRaisesLayer } from "./raises";
export { signalRepository, type PendingRaise, type SignalSummary } from "./repository";
export { SignalService, SignalServiceLayer } from "./service";
export { YourWork, YourWorkLayer } from "./your-work";
