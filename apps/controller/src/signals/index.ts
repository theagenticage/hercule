/**
 * Signals: what Intake puts in front of the user because a move is asked of
 * them, with the actions the user may take on each (spec 10 §9).
 */
export { signalRepository } from "./repository";
export {
  ACCEPT_ACTION_ID,
  DISMISS_ACTION_ID,
  HAND_TO_ACTION_PREFIX,
  SignalService,
  SignalServiceLayer,
} from "./service";
