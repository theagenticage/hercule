/**
 * `@hercule/client-core`: the public API as promises.
 *
 * The only client package that writes Effect code. The web app and the CLI
 * import `createClient` and see only promises, plain objects and the three
 * error classes below.
 */
export { describeActor, type ActorReading } from "./actor-display";
export { createClient, type FetchLike, type HerculeClient } from "./client";
export {
  buildConfigDraft,
  buildConfigFields,
  readConfigIssues,
  buildConfigPayload,
  type ConfigDraft,
  type ConfigField,
  type ConfigJson,
  type ConfigValue,
} from "./config-fields";
export {
  listConnectionTypes,
  listCredentialFields,
  filterGitHubConnections,
  buildRedirectUri,
  decideSetupFlow,
  type ConnectionType,
  type CredentialField,
  type SetupStep,
} from "./connections";
export {
  ApiError,
  ConnectionError,
  isNotFound,
  readValidationIssues,
  RequestError,
} from "./errors";
export { toIdTail } from "./id-tail";
export { readJsonObject } from "./json-shape";
export { listJsonLines, type JsonLine } from "./json-lines";
export { joinCommand } from "./join-command";
export {
  buildRetireQuestion,
  findRunnerConflictField,
  buildRunnerDraft,
  buildRunnerPatch,
  type RunnerDraft,
} from "./runner-edit";
export { describeRunnerFacts, type RunnerFactsReading } from "./runner-facts";
export {
  describeFailureReason,
  describeRunOrigin,
  describeRunStatus,
  describeStepDuration,
  describeStepState,
  describeUnstartedStep,
  findFailedEdge,
  formatElapsed,
  isRunLive,
  readTimestamps,
  shouldRunRecede,
} from "./run-display";
export {
  buildRunGraph,
  buildStepLines,
  buildTimeline,
  type EdgeTravel,
  type RunGraph,
  type RunGraphEdge,
  type RunGraphNode,
  type StepProgress,
  type StepLine,
  type Timeline,
} from "./run-graph";
export {
  buildRunInputDraft,
  buildRunInputs,
  decideRunFormIssues,
  hasConnectionField,
  buildRunForm,
  UNREADABLE_NUMBER,
  type RunInputDraft,
  type RunInputField,
  type RunInputIssues,
  type RunInputValue,
} from "./run-inputs";
export { createLive, type Live } from "./live/live";
export { queryKeys, buildQueryKeys, type LiveQueryKey } from "./live/keys";
export { detectLocalRunner, listLoopbackEndpoints } from "./local-runner";
export { describeRefusalReason } from "./plugin-refusal";
export { describeCapacity, listQueuedSessions, RUNNING_STATUSES } from "./runner-capacity";
export { buildProviderRows, type ProviderRow, type SecretFieldOffer } from "./provider-rows";
export { decideSessionsEmptyState } from "./sessions-empty-state";
export { findNextOnboardingStep, type OnboardingStep } from "./onboarding";
export { formatPreciseStamp, formatSince, formatStamp, formatTimeContext } from "./time-context";
export {
  readPriorityGlyph,
  describeProvenanceTarget,
  shouldTaskRecede,
  type GlyphTone,
} from "./task-display";
export { resolveThreadRowsMode } from "./thread-rows";
export { type AccessModeMenuItem } from "./threads/access-modes";
export { formatAge } from "./threads/age";
export { buildApprovalCard } from "./threads/approval";
export { applyPick, type ComposerPick } from "./threads/apply-pick";
export type { LoginTarget } from "./threads/catalog";
export {
  buildComposerFields,
  buildPendingModelNote,
  type ComposerBlocked,
  type ComposerFields,
  type MachineRow,
  type ModelPill,
} from "./threads/composer-fields";
export { computeEffectiveConfig, readThreadConfig } from "./threads/config";
export type {
  Thread,
  ThreadCatalogs,
  ThreadConfig,
  ThreadKind,
  ThreadPicks,
} from "./threads/config";
export { formatDuration } from "./threads/duration";
export { buildHeadline, buildLanes, type Lane, type LaneKind } from "./threads/lanes";
export { buildThreadModelField } from "./threads/model-field";
export { buildModelMenu, type ModelMenu } from "./threads/model-menu";
export { findOpenItem } from "./threads/open-item";
export { mergeTranscript } from "./threads/transcript";
export { buildOptionsLabel } from "./threads/options-label";
export { buildOptionsMenu } from "./threads/options-menu";
export { pushRecent, type RecentModel } from "./threads/recent";
export { findResumeBlockedReason } from "./threads/resume-blocked";
export { buildThreadRows, type ThreadRow } from "./threads/rows";
export {
  buildThreadGroups,
  type DraftPlace,
  decideDraftPlace,
  type ProjectGroup,
  type WorkspaceGroup,
} from "./threads/groups";
export { buildSiblingTabs, type ThreadTab } from "./threads/siblings";
export { buildProjectPickerRows, type ProjectPickerRow } from "./threads/projects";
export { pickProjectTone, type ProjectTone } from "./threads/tone";
export { buildBranchField, type BranchField } from "./threads/branch-menu";
export { buildWorkspaceMenu, type WorkspaceMenu } from "./threads/workspace-menu";
export { isClonableRemote, REMOTE_REFUSAL } from "./remote";
export {
  buildComposerPlaceholder,
  findDraftSubject,
  joinLabelText,
  joinPhraseText,
  parsePreferredWorkspace,
  listProjectRepos,
  formatRepoName,
  findRunnerForPick,
  withBranch,
  formatWorkspaceName,
  type DraftSubject,
  type Phrase,
  type WorkspaceLabel,
  type WorkspacePick,
} from "./threads/workspaces";
export { buildRunnerMenu } from "./threads/runner-menu";
export { buildSubmission } from "./threads/submission";
export { computeInstanceDefaults, computeThreadDefaults } from "./threads/thread-defaults";
export { buildTurns, type ThreadItem, type ThreadTurn } from "./threads/turns";
export {
  resolveBrowserTimezone,
  resolveDisplayTimezone,
  FALLBACK_TIMEZONE,
  isSupportedTimezone,
  listSupportedTimezones,
} from "./timezone";
export { createTokenStore } from "./token-store";
export {
  listWorkflowCompletions,
  type CompletionList,
  type CompletionOption,
  type WorkflowCatalog,
} from "./workflow-completion";
export {
  abbreviateEdgeCondition,
  buildWorkflowGraph,
  shortenCondition,
  type WorkflowGraph,
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
} from "./workflow-graph";
export {
  decideIssueState,
  formatProblemCount,
  locateIssues,
  parseWorkflowSourceWithRanges,
  type LocatedIssue,
  type ParsedWorkflowSource,
  type WorkflowValidation,
  type WorkflowValidationState,
} from "./workflow-source";
export {
  editDraft,
  applyStoredSourceChange,
  markDraftSaved,
  type WorkflowDraft,
} from "./workflow-draft";
export {
  decideWorkflowHeaderStatus,
  type WorkflowHeaderFacts,
  type WorkflowHeaderStatus,
} from "./workflow-header-status";
