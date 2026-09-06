/**
 * `@hydra/client-core`: the public API as promises.
 *
 * The one client package that writes Effect code. The web
 * app and the CLI import `createClient` and see promises, plain objects, and
 * the three error classes below - nothing else.
 */
export {
  createClient,
  type ClientOptions,
  type FetchLike,
  type HydraClient,
  type Operations,
} from "./client";
export { ApiError, ConnectionError, RequestError, type ErrorEnvelope } from "./errors";
export { ID_TAIL, idTail } from "./id-tail";
export {
  createLive,
  type Live,
  type LiveDelta,
  type LiveDeltaHandler,
  type LiveInvalidateHandler,
  type LiveOptions,
  type LiveStatus,
  type LiveWebSocketConstructor,
} from "./live/live";
export { queryKeys, queryKeysFor, type LiveQueryKey } from "./live/keys";
export {
  detectLocalRunner,
  loopbackEndpoints,
  IDENTITY_TIMEOUT_MS,
  type LoopbackEndpoint,
} from "./local-runner";
export { nextOnboardingStep, ONBOARDING_STEPS, type OnboardingStep } from "./onboarding";
export { formatBytes } from "./format-bytes";
export { formatSince, formatStamp, formatTimeContext } from "./time-context";
export {
  priorityGlyph,
  provenanceTarget,
  taskRecedes,
  type GlyphTone,
  type PriorityReading,
} from "./task-display";
export { THREAD_ROWS_DEFAULT, threadRowsMode } from "./thread-rows";
export {
  browserTimezone,
  FALLBACK_TIMEZONE,
  isSupportedTimezone,
  supportedTimezones,
  type TimezoneResolver,
} from "./timezone";
export {
  createTokenStore,
  tokenStorageKey,
  type StorageLike,
  type TokenStore,
} from "./token-store";
