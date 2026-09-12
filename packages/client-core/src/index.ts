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
export {
  configDraft,
  configFields,
  configIssues,
  configPayload,
  type ConfigDraft,
  type ConfigField,
  type ConfigFieldKind,
  type ConfigJson,
  type ConfigValue,
} from "./config-fields";
export { ApiError, ConnectionError, RequestError, type ErrorEnvelope } from "./errors";
export { ID_TAIL, idTail } from "./id-tail";
export { joinCommand } from "./join-command";
export {
  retireQuestion,
  runnerConflictField,
  runnerDraft,
  runnerPatch,
  type RetireQuestion,
  type RunnerDraft,
} from "./runner-edit";
export { runnerFactsReading, type RunnerFactsReading } from "./runner-facts";
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
export { refusalReason } from "./plugin-refusal";
export { capacityLine, queuedSessions, RUNNING_STATUSES } from "./runner-capacity";
export { providerRows, type ProviderRow } from "./provider-rows";
export { sessionsEmptyState, type SessionsEmptyState } from "./sessions-empty-state";
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
export { accessModeMenu, type AccessModeMenuItem } from "./threads/access-modes";
export { ageOf } from "./threads/age";
export { applyPick, type ComposerPick } from "./threads/apply-pick";
export {
  composerFields,
  type ComposerBlocked,
  type ComposerField,
  type ComposerFields,
  type ModelPill,
} from "./threads/composer-fields";
export type {
  MessageDraft,
  Thread,
  ThreadCatalogs,
  ThreadConfig,
  ThreadKind,
  ThreadPicks,
} from "./threads/config";
export { defaultInstanceId } from "./threads/default-instance";
export { formatDuration } from "./threads/duration";
export { headlineOf, lanesOf, type Lane, type LaneKind } from "./threads/lanes";
export {
  threadModelField,
  type ThreadModelField,
  type ThreadModelFieldOption,
} from "./threads/model-field";
export { modelGroups, type ModelGroup, type ModelGroupRow } from "./threads/model-groups";
export {
  modelMenu,
  type ModelMenu,
  type ModelMenuInstanceRow,
  type ModelMenuLane,
  type ModelMenuRecentRow,
  type ModelMenuRow,
  type ModelMenuView,
} from "./threads/model-menu";
export { modelPillLabel } from "./threads/model-pill";
export { openItemOf } from "./threads/open-item";
export { optionsLabel } from "./threads/options-label";
export { pushRecent, type RecentModel } from "./threads/recent";
export { resumeBlockedReason } from "./threads/resume-blocked";
export { threadRows, type ThreadRow } from "./threads/rows";
export {
  referenceRunner,
  runnerMenu,
  type RunnerMenu,
  type RunnerMenuRow,
} from "./threads/runner-menu";
export { submission } from "./threads/submission";
export { instanceDefaults, threadDefaults, type ThreadDefaults } from "./threads/thread-defaults";
export { turnsOf, type ThreadItem, type ThreadTurn } from "./threads/turns";
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
