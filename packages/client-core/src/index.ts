/**
 * `@hercule/client-core`: the public API as promises.
 *
 * The only client package that writes Effect code. The web app and the CLI
 * import `createClient` and see only promises, plain objects and the three
 * error classes below.
 */
export { describeActor, type ActorReading } from "./actor-display";
export { decideConversationActivity, type ConversationActivity } from "./assistants/activity";
export {
  canSteerOrCancelQueuedInputs,
  chooseMessageStamps,
  findAnsweredAssistantId,
  findWebConversation,
  flattenMessagePages,
} from "./assistants/conversation";
export {
  buildAssistantDraft,
  buildAssistantUpdate,
  dropSavedEdits,
  mergeAssistantEdits,
  type AssistantDraft,
} from "./assistants/form";
export {
  decideAssistantPresence,
  findNewestConversationSession,
  type AssistantPresence,
} from "./assistants/presence";
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
  readErrorMessage,
  readValidationIssues,
  RequestError,
} from "./errors";
export { toIdTail } from "./id-tail";
export { buildIdOptions, type IdOption } from "./id-options";
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
  describeRunnerWait,
  type RunnerWait,
  describeReruns,
  type RerunsReading,
  describeRunStatus,
  describeStepDuration,
  describeStepState,
  describeUnstartedStep,
  findFailedEdge,
  formatElapsed,
  isRunLive,
  listRerunChoices,
  type RerunChoice,
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
export { describeRunWorkspace, type RunWorkspaceReading } from "./run-workspace";
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
export {
  buildFetchIdentityProbe,
  detectLocalRunner,
  listLoopbackEndpoints,
  type IdentityProbe,
} from "./local-runner";
export {
  chooseNotificationMark,
  describeProducer,
  describeResolution,
  formatUnseenCount,
  isNotificationMuted,
  parseMuteKind,
  toggleMuteKey,
  UNSEEN_COUNT_READ_LIMIT,
  type NotificationMark,
} from "./notifications";
export { describeRefusalReason } from "./plugin-refusal";
export { describeCapacity, listQueuedSessions, RUNNING_STATUSES } from "./runner-capacity";
export { buildProviderRows, type ProviderRow, type SecretFieldOffer } from "./provider-rows";
export { decideSessionsEmptyState, hasLoggedInRunner } from "./sessions-empty-state";
export {
  chooseNewSince,
  choosePinOnOpen,
  NEVER_CHECKED,
  parseSincePin,
  splitBySince,
} from "./since-marker";
export { addCompletedStep, findNextOnboardingStep, type OnboardingStep } from "./onboarding";
export {
  chooseStamps,
  formatDay,
  formatPreciseStamp,
  formatSince,
  formatStamp,
  formatTimeContext,
} from "./time-context";
export {
  readPriorityGlyph,
  describeProvenanceTarget,
  shouldTaskRecede,
  type GlyphTone,
} from "./task-display";
export { resolveThreadRowsMode } from "./thread-rows";
export { ACCESS_MODES, formatAccessMode, type AccessModeMenuItem } from "./threads/access-modes";
export { describeAge, findNextAgeChange, formatAge } from "./threads/age";
export { buildApprovalCard } from "./threads/approval";
export {
  buildThreadBlocks,
  type AgentBlock,
  type EndingBlock,
  type LiveBlock,
  type ThreadBlock,
  type UserBlock,
  type WaitingBlock,
  type WorkBlock,
  type WorkItem,
} from "./threads/blocks";
export {
  addWorkspacePicks,
  applyPicks,
  buildModelPicks,
  buildWorkspacePicks,
  type ComposerPick,
} from "./threads/apply-pick";
export type { LoginTarget } from "./threads/catalog";
export {
  buildComposerFields,
  buildPendingModelNote,
  describeMachineRow,
  type ComposerBlocked,
  type ComposerFields,
  type MachineRow,
  type ModelPill,
} from "./threads/composer-fields";
export { computeEffectiveConfig, readThreadConfig } from "./threads/config";
export { countThreadsByPose, type ThreadCounts } from "./threads/counts";
export {
  buildDraftView,
  type DraftAddress,
  type DraftReads,
  type DraftView,
} from "./threads/draft-view";
export type {
  MessageDraft,
  Thread,
  ThreadCatalogs,
  ThreadConfig,
  ThreadKind,
  ThreadPicks,
} from "./threads/config";
export { findNextDurationChange, formatDuration } from "./threads/duration";
export { buildHeadline, buildLanes, type Lane, type LaneKind } from "./threads/lanes";
export {
  describeMessageMeta,
  describeWaitingNote,
  formatMessageTime,
} from "./threads/message-time";
export { buildThreadModelField } from "./threads/model-field";
export { buildModelMenu, type ModelMenu } from "./threads/model-menu";
export { findOpenItem } from "./threads/open-item";
export {
  decideThreadPose,
  decideThreadRowEnd,
  describePose,
  POSES,
  type Pose,
  type ThreadRowEnd,
} from "./threads/pose";
export { createTailBuffer, type TailBuffer } from "./threads/tail-buffer";
export { splitStreamingText, type StreamingText } from "./threads/streaming-text";
export { findNewRows, mergeTranscript } from "./threads/transcript";
export { buildOptionsLabel } from "./threads/options-label";
export { buildOptionsMenu } from "./threads/options-menu";
export { parseRecentModels, pushRecent, type RecentModel } from "./threads/recent";
export { decideRelatedReads, type RelatedReads } from "./threads/related-reads";
export { formatRequestQuestion } from "./threads/request-question";
export { findResumeBlockedReason } from "./threads/resume-blocked";
export { buildThreadRows, type ThreadRow } from "./threads/rows";
export { describeAgent } from "./threads/model-name";
export {
  buildThreadGroups,
  type DraftPlace,
  decideDraftPlace,
  decideDraftPlaceForPick,
  type ProjectGroup,
  type WorkspaceGroup,
} from "./threads/groups";
export {
  buildSidebarSections,
  type ExpandedSections,
  type ProjectSection,
  type SidebarSections,
  type WaitingSection,
} from "./threads/sidebar-sections";
export {
  buildSiblingTabs,
  listThreadTabs,
  listWorkspaceThreads,
  type ThreadTab,
} from "./threads/siblings";
export { buildProjectPickerRows, type ProjectPickerRow } from "./threads/projects";
export { pickProjectHue, pickProjectTone, type ProjectTone } from "./threads/tone";
export { buildBranchField, type BranchField } from "./threads/branch-menu";
export { buildWorkspaceMenu, type WorkspaceMenu } from "./threads/workspace-menu";
export {
  buildThreadWorkspaceLabel,
  type ThreadWorkspaceLabelPiece,
} from "./threads/thread-workspace";
export { describeWorkStretch, summarizeWork } from "./threads/work-summary";
export { isClonableRemote, REMOTE_REFUSAL } from "./remote";
export {
  buildComposerPlaceholder,
  findDraftSubject,
  isJoinable,
  joinLabelText,
  joinPhraseText,
  parsePreferredWorkspace,
  listProjectRepos,
  formatRepoName,
  withBranch,
  formatWorkspaceLabel,
  formatWorkspaceName,
  type DraftSubject,
  type Phrase,
  type WorkspaceLabel,
  type WorkspacePick,
} from "./threads/workspaces";
export { buildRunnerMenu } from "./threads/runner-menu";
export { buildSubmission } from "./threads/submission";
export { appendToMessage, buildStartCards, type StartCard } from "./threads/start-cards";
export {
  buildDraftConfig,
  computeInstanceDefaults,
  computeThreadDefaults,
} from "./threads/thread-defaults";
export {
  describeThreadItem,
  describeTurnDivider,
  describeTurnEnding,
  showsTurnDivider,
} from "./threads/turn-divider";
export { buildTurns, mayBeRunningTurn, type ThreadItem, type ThreadTurn } from "./threads/turns";
export { listWaitingThreads, type WaitingThread } from "./threads/waiting-threads";
export {
  resolveBrowserTimezone,
  resolveDisplayTimezone,
  FALLBACK_TIMEZONE,
  isSupportedTimezone,
  listSupportedTimezones,
} from "./timezone";
export { createTokenStore, type TokenStore } from "./token-store";
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
