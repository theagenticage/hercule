/**
 * Sessions: one provider-backed conversation, and the stream it leaves behind.
 *
 * The rows, their lifecycle, the inputs waiting on them and the frames a
 * machine is told about them are this domain's; when a frame goes out, and
 * over which connection, is not. `SessionService` carries the read operations
 * and the stored-input operations a request reaches directly, beside the
 * frames and the row moves the controller daemon calls as it sequences what a
 * machine is told.
 */
export { type StoredInput } from "./inputs";
export { buildContinuingSpec, timeoutsFrom, validatedOptions } from "./options";
export { sessionRecordComposer } from "./records";
export {
  LIVE_SESSION_STATUSES,
  requireSession,
  sessionRepository,
  type StoredSession,
} from "./repository";
export { cancelStrandedInputs, SessionService, SessionServiceLayer } from "./service";
export { headOfTranscript, sessionExists, transcriptRowsAfter } from "./transcript-log";
