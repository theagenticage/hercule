/**
 * `@hydra/client-core`: the public API as promises.
 *
 * The one client package that writes Effect code. The web
 * app and the CLI import `createClient` and see promises, plain objects, and
 * the three error classes below - nothing else.
 */
export { createClient, type FetchLike, type HydraClient } from "./client";
export {
  configDraft,
  configFields,
  configIssues,
  configPayload,
  type ConfigDraft,
  type ConfigField,
  type ConfigJson,
  type ConfigValue,
} from "./config-fields";
export {
  connectionTypes,
  credentialFieldsOf,
  githubConnections,
  redirectUriFor,
  setupFlowOf,
  type ConnectionType,
  type CredentialField,
  type SetupStep,
} from "./connections";
export { ApiError, ConnectionError, RequestError } from "./errors";
export { idTail } from "./id-tail";
export { joinCommand } from "./join-command";
export {
  retireQuestion,
  runnerConflictField,
  runnerDraft,
  runnerPatch,
  type RunnerDraft,
} from "./runner-edit";
export { runnerFactsReading, type RunnerFactsReading } from "./runner-facts";
export { createLive, type Live } from "./live/live";
export { queryKeys, queryKeysFor, type LiveQueryKey } from "./live/keys";
export { detectLocalRunner, loopbackEndpoints } from "./local-runner";
export { refusalReason } from "./plugin-refusal";
export { capacityLine, queuedSessions, RUNNING_STATUSES } from "./runner-capacity";
export { providerRows, type ProviderRow } from "./provider-rows";
export { sessionsEmptyState } from "./sessions-empty-state";
export { nextOnboardingStep, type OnboardingStep } from "./onboarding";
export { formatSince, formatStamp, formatTimeContext } from "./time-context";
export { priorityGlyph, provenanceTarget, taskRecedes, type GlyphTone } from "./task-display";
export { threadRowsMode } from "./thread-rows";
export { type AccessModeMenuItem } from "./threads/access-modes";
export { ageOf } from "./threads/age";
export { approvalCard } from "./threads/approval";
export { applyPick, type ComposerPick } from "./threads/apply-pick";
export type { LoginTarget } from "./threads/catalog";
export {
  composerFields,
  pendingModelNote,
  type ComposerBlocked,
  type ComposerFields,
  type MachineRow,
  type ModelPill,
} from "./threads/composer-fields";
export { effectiveConfig, threadConfig } from "./threads/config";
export type {
  Thread,
  ThreadCatalogs,
  ThreadConfig,
  ThreadKind,
  ThreadPicks,
} from "./threads/config";
export { formatDuration } from "./threads/duration";
export { headlineOf, lanesOf, type Lane, type LaneKind } from "./threads/lanes";
export { threadModelField } from "./threads/model-field";
export { modelMenu, type ModelMenu } from "./threads/model-menu";
export { openItemOf } from "./threads/open-item";
export { mergeTranscript } from "./threads/transcript";
export { optionsLabel } from "./threads/options-label";
export { optionsMenu } from "./threads/options-menu";
export { pushRecent, type RecentModel } from "./threads/recent";
export { resumeBlockedReason } from "./threads/resume-blocked";
export { threadRows, type ThreadRow } from "./threads/rows";
export {
  threadGroups,
  type DraftPlace,
  type ProjectGroup,
  type WorkspaceGroup,
} from "./threads/groups";
export { siblingTabs, type ThreadTab } from "./threads/siblings";
export { projectPickerRows, projectTone, type ProjectPickerRow } from "./threads/projects";
export { branchField, type BranchField } from "./threads/branch-menu";
export { workspaceMenu, type WorkspaceMenu } from "./threads/workspace-menu";
export {
  draftSubject,
  projectRepos,
  repoName,
  runnerForPick,
  withBranch,
  type DraftSubject,
  type WorkspacePick,
} from "./threads/workspaces";
export { runnerMenu } from "./threads/runner-menu";
export { submission } from "./threads/submission";
export { instanceDefaults, threadDefaults } from "./threads/thread-defaults";
export { turnsOf, type ThreadItem, type ThreadTurn } from "./threads/turns";
export {
  browserTimezone,
  FALLBACK_TIMEZONE,
  isSupportedTimezone,
  supportedTimezones,
} from "./timezone";
export { createTokenStore } from "./token-store";
