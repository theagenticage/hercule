/**
 * Signals: what Intake puts in front of the user because a move is asked of
 * them, with the actions the user may take on each (spec 10 §9).
 */
export { truncateOutcome } from "./outcome";
export { SignalClaims, SignalClaimsLayer } from "./claims";
export { readThreadRef, SignalHandoffs, SignalHandoffsLayer } from "./handoffs";
export { IgnoreRuleService, IgnoreRuleServiceLayer } from "./ignore-rules";
export { SignalRaises, SignalRaisesLayer } from "./raises";
export {
  buildLiveThreadSignalExists,
  OPEN_THREAD_REFS_SQL,
  signalRepository,
  type LiveThreadSignals,
  type PendingRaise,
  type SignalSummary,
  type ThreadSignal,
  type ThreadSignalLines,
} from "./repository";
export { SignalEntities } from "./signal-entities";
export { SignalService, SignalServiceLayer } from "./service";
export { YourWork, YourWorkLayer } from "./your-work";
