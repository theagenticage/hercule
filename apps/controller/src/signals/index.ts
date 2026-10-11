/**
 * Signals: what Intake puts in front of the user because a move is asked of
 * them, with the actions the user may take on each (spec 10 §9).
 */
export { signalRepository, type OpenSignalOnThread, type PendingRaise } from "./repository";
export {
  buildHandToActions,
  listCollisionIssues,
  SignalService,
  SignalServiceLayer,
} from "./service";
