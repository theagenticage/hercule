/**
 * Sessions: one run of a provider-backed agent, and the stream of events it
 * leaves behind.
 *
 * This domain owns the session rows, their lifecycle, the inputs waiting on
 * them, and the frames sent to a runner about them. It does not decide when a
 * frame is sent or over which connection; the controller daemon does.
 * `SessionService` holds the read operations and the stored-input operations
 * that a request calls directly. It also builds the frames and makes the
 * status changes that the controller daemon calls while it talks to a runner.
 */
export type { WaitEndedBy } from "./approval-notification";
export { SessionObserver, type SessionEndReason, type SessionExit } from "./observer";
export { inputRepository, type LostWakeUp, type StoredInput } from "./inputs";
export {
  buildContinuingSpec,
  buildConversationTimeouts,
  buildTimeouts,
  validateOptions,
} from "./options";
export { sessionRecordComposer } from "./records";
export { validateAnswers, validateDecision } from "./responses";
export { isResumeHeld } from "./resume-hold";
export {
  LIVE_SESSION_STATUSES,
  readSessionOrFail,
  sessionRepository,
  type SessionAccess,
  type SessionRows,
  type StoredSession,
} from "./repository";
export {
  cancelStrandedInputs,
  SessionService,
  SessionServiceLayer,
  type StartRequest,
} from "./service";
export { attributeEvent } from "./stream";
export {
  agentExists,
  readAssistantTexts,
  readTranscriptHead,
  readTranscriptRowsAfter,
} from "./transcript-log";
