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
  mergeNewestMessagePage,
  mergeSentMessage,
  type MessagePage,
  type MessagePages,
  type SentMessageMerge,
} from "./assistants/conversation";
export {
  buildConversationBlocks,
  collectRunningTurnRows,
  describeOpenReply,
  trimToRunningTurn,
  type ConversationBlock,
  type OpenReplyBlock,
} from "./assistants/conversation-blocks";
export {
  buildAssistantDraft,
  buildAssistantUpdate,
  describeWhenAssistantChangesApply,
  dropSavedEdits,
  mergeAssistantEdits,
  NEW_ASSISTANT_NAME,
  type AssistantDraft,
} from "./assistants/form";
export { setDisallowedTool } from "./assistants/disallowed-tools";
export {
  buildHeartbeatDay,
  buildHeartbeatSchedule,
  changeHeartbeatInterval,
  computeHeartbeatNow,
  listHeartbeatIntervalChoices,
  moveHeartbeatEnd,
  moveHeartbeatStart,
  parseHeartbeatWindow,
  type HeartbeatWindow,
  type HeartbeatWindowEdit,
} from "./assistants/heartbeat";
export {
  decideAssistantPresence,
  findNewestConversationSession,
  type AssistantPresence,
} from "./assistants/presence";
export {
  formatContextFraction,
  formatTokenLimit,
  listContextFractionChoices,
  listContextTokenChoices,
} from "./assistants/rotation";
export { buildAssistantProviderField } from "./assistants/provider-field";
export { buildAssistantRows, decideAssistantPose, type AssistantRow } from "./assistants/rows";
export { checkImageFile, formatAttachmentSize, type ImageFile } from "./attachments/files";
export {
  addFilesToShelf,
  applyUploadOutcome,
  decideShelfTileState,
  describeSendBlock,
  EXPIRED_ATTACHMENT_MESSAGE,
  findExpiredShelfKeys,
  listUploadedAttachmentIds,
  markShelfItemFailed,
  markShelfItemsExpired,
  markShelfItemUploaded,
  markShelfItemUploading,
  removeShelfItem,
  type ShelfItem,
  type ShelfItemStatus,
  type ShelfModel,
  type ShelfTileState,
} from "./attachments/shelf";
export {
  createUploadQueue,
  UPLOAD_CONCURRENCY,
  type UploadOutcome,
  type UploadQueue,
} from "./attachments/upload-queue";
export {
  createClient,
  MAX_INPUT_ANSWER_WAIT_MS,
  type FetchLike,
  type HerculeClient,
} from "./client";
export {
  buildConfigDraft,
  buildConfigFields,
  readConfigHeading,
  readConfigIssues,
  buildConfigPayload,
  type ConfigDraft,
  type ConfigIssues,
  type ConfigField,
  type ConfigJson,
  type ConfigValue,
} from "./config-fields";
export {
  listConnectionTypes,
  listCredentialFields,
  filterGitHubConnections,
  showsAccountBesideLabel,
  showsPluginName,
  buildTopicsUpdate,
  buildRedirectUri,
  listSetupFlows,
  decideDeviceFlowStep,
  describeDeviceFlowWait,
  DEVICE_FLOW_ENDINGS,
  describeGitHubSignInEnding,
  describeGitHubSignInFailure,
  waitForDeviceFlow,
  connectionNeedsAttention,
  describeFeedName,
  describeFeedInterval,
  buildFeedIntervalsDraft,
  buildFeedIntervalsPayload,
  readConnectionIssues,
  type ConnectionFeed,
  type ConnectionIssues,
  type ConnectionType,
  type FeedIntervalsDraft,
  type DeviceFlowStep,
  type DeviceFlowWatcher,
  type GitHubSignInEnding,
  type SetupFlow,
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
export { describeTrigger, describeTriggerOn, type TriggerReading } from "./trigger-display";
export { isWebLink } from "./web-link";
export { listWaiting, type Waiting, type WaitingAssistant, type WaitingThread } from "./waiting";
export { buildIdOptions } from "./id-options";
export { readJsonObject, readStringList } from "./json-shape";
export { listJsonLines } from "./json-lines";
export { joinCommand } from "./join-command";
export {
  buildRetireQuestion,
  findRunnerConflictField,
  buildRunnerDraft,
  buildRunnerPatch,
  type RunnerDraft,
} from "./runner-edit";
export { describeRunnerFacts, type RunnerFactsReading } from "./runner-facts";
export { formatRunnerLabel } from "./runner-label";
export { describeInputStatus } from "./input-status";
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
  findFailedEdge,
  findStepLineKind,
  formatElapsed,
  isRunLive,
  listAwaitedSignals,
  measureElapsed,
  listRerunChoices,
  readTimestamps,
  shouldRunRecede,
  describeStepSession,
  type StepLineKind,
  type StepRecordSession,
  type StepSessionReading,
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
export { invalidateWithoutCancelling } from "./live/invalidation";
export { readEveryPage } from "./read-every-page";
export { isMutationRunning } from "./mutation-running";
export { queryKeys, buildQueryKeys, type LiveQueryKey } from "./live/keys";
export { buildFetchIdentityProbe, detectLocalRunner } from "./local-runner";
export {
  buildBoundActionRows,
  chooseNotificationMark,
  describeProducer,
  describeResolution,
  formatDescribeLine,
  formatUnseenCount,
  isNotificationMuted,
  parseMuteKind,
  toggleMuteKey,
  UNSEEN_COUNT_READ_LIMIT,
  type BoundActionRow,
  type NotificationMark,
} from "./notifications";
export { describeRefusalReason } from "./plugin-refusal";
export { describeCapacity, listQueuedSessions, RUNNING_STATUSES } from "./runner-capacity";
export { buildProviderRows, type ProviderRow, type SecretFieldOffer } from "./provider-rows";
export {
  decideDeviceLoginStep,
  describeDeviceLoginWait,
  startProviderLogin,
  type DeviceLogin,
  type DeviceLoginStep,
  type StartedProviderLogin,
} from "./device-login";
export {
  computeNextMinuteTick,
  countMinutesLeft,
  describeCodeExpiry,
  describeMinutes,
} from "./minutes-left";
export { isLoginCodeRejected } from "./login-code";
export { describeReadOnlySecret, WRITABLE_OWNER_KINDS } from "./secret-owners";
export { decideSessionsEmptyState, hasLoggedInRunner } from "./sessions-empty-state";
export {
  createProjectWithRepositories,
  findProjectLocalRunner,
  isNewProjectCreated,
  isProjectWorkspacePending,
  reconcileProjectWorkspaces,
  type NewProjectForm,
  type NewProjectSubmission,
  type ProjectWorkspaceSelection,
  type RepositorySubmission,
} from "./new-project";
export { completeSetup, validatePasswordLength } from "./setup";
export {
  addPutOffStep,
  buildAllSetRecap,
  findDoneSteps,
  buildFirstRunHost,
  findGitHubAccount,
  buildFirstRunLadder,
  buildProvidersStepText,
  buildRoomContents,
  decideFirstRunStep,
  FIRST_RUN_STEPS,
  type AllSetRecap,
  type FirstRunDoneSteps,
  type FirstRunHost,
  type FirstRunReads,
  type FirstRunRungStatus,
  type FirstRunStep,
  type ProvidersStepText,
  type RoomContents,
  type RoomWing,
} from "./first-run";
export { formatControllerAddress, isLoopbackOrigin } from "./controller-origin";
export { formatNameList } from "./name-list";
export {
  applyGrantChange,
  chooseNewProfileName,
  describeProfileAgents,
  describeProfileInUse,
  describeUnrestrictedGrantChange,
  formatGrantVerb,
  GRANT_FAMILY_TEXT,
  groupAgentsByProfile,
  isUnrestrictedProfile,
  readGrantFamily,
  sortProfiles,
  type GrantChange,
  type ProfileAgent,
} from "./permission-profiles";
export { chooseNewSince, choosePinOnOpen, parseSincePin, splitBySince } from "./since-marker";
export {
  decideOfficeSeating,
  isSeatedPose,
  type OfficeDesk,
  type OfficeRoom,
  type OfficeSeating,
  type SeatedPose,
} from "./office/seating";
export {
  addCompletedStep,
  findNextOnboardingStep,
  ONBOARDING_STEPS,
  type OnboardingStep,
} from "./onboarding";
export {
  chooseStamps,
  formatDayStamp,
  formatPreciseStamp,
  formatSince,
  formatStamp,
  formatTimeContext,
  isSameDay,
} from "./time-context";
export { readPriorityGlyph, describeProvenanceTarget, shouldTaskRecede } from "./task-display";
export {
  describeBriefSource,
  findSubagentBrief,
  splitSubagentBrief,
  type BriefSource,
  type SubagentBriefSplit,
  type SubagentBrief,
} from "./subagents/brief";
export {
  decideSubagentMark,
  decideSubagentPose,
  describeSubagentLine,
  describeSubagentMeta,
  describeSubagentState,
  describeSubagentStop,
  formatTokenCount,
  isSubagentWaiting,
  nameSubagentParent,
  type SubagentHue,
  type SubagentLine,
  type SubagentMark,
  type SubagentState,
  type SubagentStop,
} from "./subagents/describe";
export { nameSubagent } from "./subagents/name";
export {
  buildRequestDock,
  describeRequestAsker,
  type RequestAsker,
  type RequestAskerWords,
  type RequestDockState,
} from "./subagents/request-dock";
export { buildSpawnLines, findSpawnedSubagents, type SpawnLine } from "./subagents/spawn-lines";
export { describeStatusCard, type StatusCardText } from "./subagents/status-card";
export { describeSubagentTally, summarizeSubagents, type SubagentTally } from "./subagents/tally";
export {
  buildSubagentTree,
  listSubagentAncestors,
  listSubagentDescendants,
  type SubagentNode,
} from "./subagents/tree";
export { resolveThreadRowsMode } from "./thread-rows";
export { findTimeOfDayError, formatTimeOfDay } from "./time-of-day";
export { countUsedTokens, describeTokenUsage } from "./token-usage";
export { formatAccessMode, type AccessModeMenuItem } from "./threads/access-modes";
export { describeAge, findNextAgeChange, formatAge } from "./threads/age";
export {
  buildSessionAgentState,
  buildSubagentAgentState,
  type AgentState,
} from "./threads/agent-state";
export { buildApprovalCard, type ApprovalQuestion } from "./threads/approval";
export {
  buildThreadBlocks,
  type AgentBlock,
  type EndingBlock,
  type PendingBlock,
  type ThreadBlock,
  type WorkBlock,
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
export { computeEffectiveConfig, holdsMessageContent, readThreadConfig } from "./threads/config";
export { countThreadsByPose, type ThreadCounts } from "./threads/counts";
export { buildDraftView, type DraftAddress, type DraftView } from "./threads/draft-view";
export type {
  MessageDraft,
  Thread,
  ThreadCatalogs,
  ThreadConfig,
  ThreadKind,
  ThreadPicks,
} from "./threads/config";
export { findNextDurationChange, formatDuration } from "./threads/duration";
export {
  buildHeadline,
  buildLanes,
  buildStepSessionRows,
  describeStartingRun,
  summarizeStepSessions,
  type LaneKind,
} from "./threads/lanes";
export {
  describeMessageMeta,
  describeWaitingNote,
  formatMessageTime,
} from "./threads/message-time";
export { buildThreadModelField } from "./threads/model-field";
export { buildModelMenu, type ModelMenu } from "./threads/model-menu";
export { describeAccountRow, describeModelRow } from "./threads/model-menu-details";
export { findOpenItem } from "./threads/open-item";
export {
  decideThreadPose,
  decideThreadRowEnd,
  describePose,
  POSES,
  type Pose,
  type ThreadRowEnd,
} from "./threads/pose";
export { createTailBuffer } from "./threads/tail-buffer";
export { splitStreamingText } from "./threads/streaming-text";
export { buildStreamCursor, decideStreamDelivery, decideTapDelivery } from "./threads/thread-live";
export { buildOptionsLabel } from "./threads/options-label";
export { buildOptionsMenu } from "./threads/options-menu";
export { parseOptionChoice } from "./threads/option-choice";
export {
  buildRecentModel,
  parseRecentModels,
  pushRecent,
  type RecentModel,
} from "./threads/recent";
export { decideRelatedReads } from "./threads/related-reads";
export { findOldestOpenRequest } from "./threads/oldest-request";
export { formatRequestQuestion } from "./threads/request-question";
export {
  changeRequestDraft,
  dropClosedRequestDrafts,
  EMPTY_REQUEST_DRAFT,
  type RequestDraft,
} from "./threads/request-drafts";
export {
  buildQuestionAnswers,
  buildQuestionDraft,
  isQuestionAnswered,
  pickQuestionOption,
  typeQuestionAnswer,
  type QuestionDraft,
} from "./threads/question-draft";
export { findResumeBlockedReason } from "./threads/resume-blocked";
export { buildThreadRows, type ThreadRow } from "./threads/rows";
export { describeAgent } from "./threads/model-name";
export {
  buildThreadGroups,
  type DraftPlace,
  decideDraftPlace,
  type ProjectGroup,
  type WorkspaceGroup,
} from "./threads/groups";
export {
  holdsDraft,
  listProjectRows,
  sortProjectsByNewestThread,
  type ProjectRow,
} from "./threads/project-rows";
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
export {
  CLOSED_SIDE_PANE,
  DEFAULT_SIDE_PANE_WIDTH,
  MIN_MAIN_PANE_WIDTH,
  MIN_SIDE_PANE_WIDTH,
  SIDE_PANE_SURFACES,
  closeSidePaneSurface,
  fitSidePaneWidth,
  openSidePaneSurface,
  parseSidePaneLayout,
  parseSidePaneWidth,
  toggleSidePane,
  toggleSidePaneSurface,
  type SidePaneLayout,
  type SidePaneSurface,
} from "./threads/side-pane";
export { buildProjectPickerRows, type ProjectPickerRow } from "./threads/projects";
export { pickProjectHue, type ProjectTone } from "./threads/tone";
export { buildBranchField, type BranchField } from "./threads/branch-menu";
export { buildWorkspaceMenu, type WorkspaceMenu } from "./threads/workspace-menu";
export { buildThreadWorkspaceLabel } from "./threads/thread-workspace";
export { buildWorkspaceDetails, type WorkspaceDetails } from "./workspace-details";
export { describePending, describeWorkStretch, summarizeWork } from "./threads/work-summary";
export {
  describeRemoteRefusal,
  isClonableRemote,
  isGitHubRemote,
  parseRepositoryName,
  REMOTE_REFUSAL,
  REMOTE_USERINFO_REFUSAL,
} from "./remote";
export {
  buildComposerPlaceholder,
  type DraftSubject,
  findDraftSubject,
  isJoinable,
  joinLabelText,
  joinPhraseText,
  listProjectRepos,
  setWorkspaceStartingRevision,
  formatWorkspaceLabel,
  type Phrase,
  type WorkspaceLabel,
  type WorkspacePick,
} from "./threads/workspaces";
export { buildSubmission } from "./threads/submission";
export { appendToMessage, buildStartCards } from "./threads/start-cards";
export {
  chooseStarterThreads,
  describeEmptyIntake,
  type StarterThread,
} from "./threads/starter-threads";
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
export {
  resolveBrowserTimezone,
  resolveDisplayTimezone,
  FALLBACK_TIMEZONE,
  isSupportedTimezone,
  listSupportedTimezones,
  listTimezoneChoices,
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
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
} from "./workflow-graph";
export {
  decideIssueState,
  formatProblemCount,
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
export { decideWorkflowHeaderStatus, type WorkflowHeaderStatus } from "./workflow-header-status";
