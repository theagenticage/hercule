/**
 * Sessions: one provider-backed conversation, and the stream it leaves behind.
 *
 * The rows, their lifecycle and the inputs waiting on them are this domain's;
 * what reaches a machine is not. `SessionService` carries the read operations
 * and the stored-input operations a request reaches directly, beside the row
 * moves the controller daemon calls as it sequences what a machine is told.
 */
export { type StoredInput } from "./inputs";
export { continuingSpecOf, timeoutsFrom, validatedOptions } from "./options";
export { requireSession, sessionRepository, type StoredSession } from "./repository";
export { cancelStrandedInputs, SessionService, SessionServiceLayer } from "./service";
export { headOfTranscript, sessionExists, transcriptRowsAfter } from "./transcript-log";
