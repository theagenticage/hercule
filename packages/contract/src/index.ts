/**
 * `@hercule/contract`: the public API declared once, in Effect Schema.
 *
 * The controller derives its routes and its request validation from `api`, the
 * CLI and `client-core` derive their client from it, and the OpenAPI document
 * is generated from it. `OPERATIONS` is the route and grant table that every
 * 403 response and every `hercule ... --help` is built from.
 */
/** The version of the public API that this build implements. */
export const API_VERSION = 1;

export { api } from "./api";

export {
  ALL_OPERATIONS,
  API_PREFIX,
  OPERATIONS,
  isOperationId,
  readRequirement,
  type Method,
  type Operation,
  type OperationId,
  type Requirement,
} from "./operations";

export { ALL_GRANTS, GRANT_FAMILIES, GrantSchema, type Grant, type GrantFamily } from "./grants";

export { DESKTOP_APP_ORIGIN } from "./desktop-app";

export {
  decodeBindableOperation,
  dispatchBindableOperation,
  OWN_SESSION_ALIAS,
  type BindableOperation,
  type BindableOperationHandlers,
  type BindableOperationId,
  type BindableOperationInput,
} from "./bound-operations";

export { CLI, NOUNS, type CliExample, type CliRow, type FieldRow, type NounRow } from "./cli";

export {
  CapExceeded,
  Conflict,
  ERROR_CODES,
  ERROR_STATUS,
  Forbidden,
  Internal,
  InvalidState,
  Issue,
  NotFound,
  Unauthenticated,
  Validation,
  createCapExceededError,
  createConflictError,
  createDecodeValidationError,
  createForbiddenError,
  createInternalError,
  createInvalidStateError,
  createNotFoundError,
  createUnauthenticatedError,
  createValidationError,
  formatIssue,
  listDecodeIssues,
  listSchemaIssues,
  isApiError,
  type ApiError,
  type CapDetails,
  type ErrorCode,
} from "./errors";

export {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  SortDirection,
  page,
  pageParams,
  readSortFields,
  sortParam,
} from "./pagination";

export { ACCESS_MODE_CHAIN, findNearestSupportedAccessMode } from "./access-modes";

export {
  MAX_PASSWORD_LENGTH,
  MAX_TIMEZONE_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  NewPassword,
  PresentedPassword,
  Timezone,
  Username,
  atMost,
  bounded,
} from "./strings";

export { LoginForm, SetupForm, TaskCreateForm } from "./forms";

/** The form-validation interface that the form schemas above implement. */
export type { StandardSchemaV1 } from "effect/StandardSchema";

export {
  Actor,
  ExternalRef,
  Id,
  isId,
  MAX_EXTERNAL_REF_LENGTH,
  NullableActor,
  Timestamp,
} from "./ids";

export { Authenticated, SetupToken } from "./security";

export { SetupPayload, SetupResult, SetupState } from "./groups/setup";
export { LoginPayload, LoginResult, WsTicket } from "./groups/auth";
export { ApiKey, MintedApiKey } from "./groups/api-key";
export { SignedInUser } from "./groups/user";
export {
  AccessMode,
  ControllerSettings,
  MAX_SETTING_LIST,
  SETTING_VALUES,
  SettingsPatch,
  SettingsState,
  ThreadRows,
  ThreadWorkspace,
  UserSettings,
} from "./groups/settings";
export {
  MAX_PLUGIN_MESSAGE_LENGTH,
  PluginCapability,
  PluginConfigSchema,
  PluginConfigureInput,
  PluginContribution,
  PluginDetail,
  PluginRefusalReason,
  PluginStatus,
} from "./groups/plugin";
export { MAX_PROFILE_GRANTS, Profile } from "./groups/profile";
export {
  CapabilitySnapshot,
  DeclaredCapabilities,
  MAX_PROVIDER_INSTANCE_NAME_LENGTH,
  ModelDescriptor,
  ModelOption,
  ProviderInstance,
  ProviderInstanceCreateInput,
  ProviderInstanceUpdateInput,
  ProviderLoginCodeInput,
  ProviderLoginInput,
  ProviderSecretField,
  SnapshotAuth,
  VersionVerdict,
} from "./groups/provider";
export {
  AGENT_SORT_FIELDS,
  Agent,
  AgentCreateInput,
  AgentFilter,
  AgentUpdateInput,
  DisallowedTool,
  UnenforcedSpecField,
} from "./groups/agent";
export {
  ASSISTANT_SORT_FIELDS,
  Assistant,
  AssistantCreateInput,
  AssistantReply,
  AssistantUpdateInput,
  Heartbeat,
  Rotation,
} from "./groups/assistant";
export {
  CONVERSATION_SORT_FIELDS,
  Conversation,
  ConversationChannel,
  ConversationFilter,
  ConversationMessage,
  ConversationSenderRole,
  ConversationSendInput,
  MESSAGE_SORT_FIELDS,
} from "./groups/conversation";
export {
  ApprovalDecision,
  MAX_PROMPT_LENGTH,
  MAX_SPAWN_CHECKOUTS,
  OpenRequest,
  QuestionAnswers,
  SESSION_CONTINUE_FIELDS,
  SESSION_INPUT_FIELDS,
  SESSION_RESPOND_FIELDS,
  SESSION_SELECTION_FIELDS,
  SESSION_SORT_FIELDS,
  SESSION_STATUSES,
  SESSION_UPDATE_FIELDS,
  Session,
  SessionContinueInput,
  SessionFilter,
  SessionInputOutcome,
  SessionInputPayload,
  SessionRespondInput,
  SessionSelection,
  SessionSpawnInput,
  SessionStatus,
  SessionUpdateInput,
  SpawnCheckout,
  SpawnWorkspace,
} from "./groups/session";
export {
  INPUT_SORT_FIELDS,
  INPUT_SOURCES,
  INPUT_UPDATE_FIELDS,
  INPUT_STATUSES,
  Input,
  InputSource,
  InputStatus,
  InputUpdatePayload,
} from "./groups/input";
export { StructuredResult, TRANSCRIPT_SORT_FIELDS, TranscriptRow } from "./groups/transcript";
export { OwnerKind, SecretRef } from "./groups/secret";
export {
  CONNECTION_SORT_FIELDS,
  Connection,
  ConnectionCreateInput,
  ConnectionCredentialsInput,
  ConnectionOAuthStart,
  ConnectionOAuthStartInput,
  ConnectionStatus,
  ConnectionUpdateInput,
  CredentialRef,
  GITHUB_CONNECTION_TYPE,
  MAX_CONNECTION_LABEL_LENGTH,
} from "./groups/connection";
export { ControllerInfo, ControllerUpdateInput } from "./groups/controller";
export {
  IDENTITY_PORT,
  IDENTITY_PORT_COUNT,
  JoinTokenRef,
  MAX_RUNNER_LABELS,
  MAX_RUNNER_LABEL_LENGTH,
  MAX_RUNNER_NAME_LENGTH,
  MintedJoinToken,
  RUNNER_EDIT_FIELDS,
  RUNNER_RETIRE_FIELDS,
  RUNNER_SORT_FIELDS,
  Runner,
  RunnerCapabilities,
  RunnerConnectivity,
  RunnerDetail,
  RunnerFacts,
  RunnerFilter,
  RunnerLifecycle,
  RunnerProvider,
  RunnerRetireInput,
  RunnerToolchain,
  RunnerUpdateInput,
  RunnerWatermark,
} from "./groups/runner";
export {
  Label,
  MAX_FILTER_VALUES,
  MAX_LABEL_LENGTH,
  MAX_PROVENANCE_APPEND,
  MAX_SEARCH_TEXT_LENGTH,
  MAX_TASK_LABELS,
  MAX_TASK_DESCRIPTION_LENGTH,
  MAX_TASK_TITLE_LENGTH,
  ProvenanceEntry,
  TASK_PRIORITIES,
  TASK_SORT_FIELDS,
  TASK_STATUSES,
  Task,
  TaskCreateInput,
  TaskCreatedEventPayload,
  TaskFilter,
  TaskPriority,
  TaskStatus,
  TaskUpdateCall,
  TaskUpdateInput,
  TaskUpdatedEventPayload,
  refuseEmptyTaskUpdate,
} from "./groups/task";
export {
  BoundAction,
  BoundOperation,
  CORE_KIND_PREFIX,
  CORE_NOTIFICATION_KINDS,
  MAX_ACTION_DESCRIPTION_LENGTH,
  MAX_ACTION_ID_LENGTH,
  MAX_ACTION_LABEL_LENGTH,
  MAX_BOUND_INPUT_BYTES,
  MAX_NOTIFICATION_ACTIONS,
  MAX_NOTIFICATION_BODY_LENGTH,
  MAX_NOTIFICATION_KIND_LENGTH,
  MAX_NOTIFICATION_SUBJECTS,
  MAX_NOTIFICATION_TITLE_LENGTH,
  MAX_WITHDRAW_REASON_LENGTH,
  DescribeLine,
  DescribeLinePart,
  MuteKey,
  NOTIFICATION_SORT_FIELDS,
  Notification,
  NotificationActInput,
  NotificationAction,
  NotificationCreateInput,
  NotificationCreateResult,
  NotificationFilter,
  NotificationKind,
  NotificationProducer,
  NotificationStatus,
  NotificationSubject,
  NotificationWithdrawInput,
  type CoreNotificationKind,
  Resolution,
  ResolutionOrigin,
} from "./groups/notification";
export {
  MAX_PROJECT_DESCRIPTION_LENGTH,
  MAX_PROJECT_NAME_LENGTH,
  PROJECT_SORT_FIELDS,
  Project,
  ProjectCreateInput,
  ProjectUpdateInput,
} from "./groups/project";
export {
  MAX_REMOTE_LENGTH,
  MAX_RESOURCE_LABEL_LENGTH,
  MAX_RESOURCE_PROJECTS,
  MAX_SETUP_COMMAND_LENGTH,
  RESOURCE_KINDS,
  RESOURCE_SORT_FIELDS,
  RESOURCE_UPDATE_FIELDS,
  Resource,
  ResourceCreateInput,
  ResourceFilter,
  ResourceKind,
  ResourceUpdateInput,
} from "./groups/resource";
export {
  Branch,
  Checkout,
  CheckoutForm,
  MAX_BRANCH_LENGTH,
  WORKSPACE_SORT_FIELDS,
  WORKSPACE_STATUSES,
  Workspace,
  WorkspaceFilter,
  WorkspaceKind,
  WorkspaceProvisionInput,
  WorkspaceStatus,
} from "./groups/workspace";
export {
  EventEmitInput,
  EventEmitted,
  EventEnrichInput,
  EVENT_SORT_FIELDS,
  Event,
  EventId,
  MAX_EVENT_KIND_LENGTH,
} from "./groups/event";
export {
  SUBSCRIPTION_SORT_FIELDS,
  Subscription,
  SubscriptionCreateInput,
  SubscriptionCreated,
  SubscriptionHealth,
  SubscriptionHolder,
  SubscriptionTarget,
  SubscriptionTargetFromShorthand,
} from "./groups/subscription";
export {
  WORKFLOW_SORT_FIELDS,
  WORKFLOW_UPDATE_FIELDS,
  Workflow,
  WorkflowCreateInput,
  WorkflowFilter,
  WorkflowIssues,
  WorkflowSaveResult,
  WorkflowSummary,
  WorkflowUpdateInput,
  WorkflowValidateInput,
} from "./groups/workflow";
export {
  ANY_CONNECTION,
  collectReachableSteps,
  decodeWorkflowDefinition,
  EventSelector,
  isSchedule,
  Schedule,
  TriggerFiresOn,
  TriggerOn,
  truncateIssues,
  listEntrySteps,
  readFieldNotation,
  WorkflowDefinition,
  WorkspacePolicy,
  type FieldNotation,
} from "./groups/workflow-definition";
export {
  parseWorkflowDocument,
  parseWorkflowSource,
  renderWorkflowSource,
  convertKeyToPathSegment,
} from "./groups/workflow-source";
export { STARTER_WORKFLOW_SOURCE } from "./groups/workflow-starter";
export {
  FailedEdge,
  FailureReason,
  RERUN_MODES,
  RerunMode,
  Run,
  RunCancelInput,
  RunCancelledEventPayload,
  RunCompletedEventPayload,
  RunFailedEventPayload,
  RunRerunInput,
  RUN_SORT_FIELDS,
  RUN_STATUSES,
  RunFilter,
  RunInputs,
  RunOrigin,
  RunStartCall,
  RunStartInput,
  RunStarted,
  RunStatus,
  RunSummary,
  StepError,
  StepRecord,
  StepStatus,
  TriggerEvent,
} from "./groups/run";
export { truncateText, shortenLibraryMessage, joinNames, quoteAuthorText } from "./excerpts";
export { APPROVAL_ANSWER_LABELS, describeApprovalAnswer } from "./approval-answers";
export { WorkflowAction, WorkflowActionRunsIn } from "./groups/workflow-action";
export { DeclaredEventKind } from "./groups/event-kind";
export {
  CronTickEventPayload,
  SkippedTicks,
  TRIGGER_SORT_FIELDS,
  Trigger,
  TriggerFilter,
  TriggerHealth,
  TriggerKey,
  TriggerKind,
  TriggerStatus,
} from "./groups/trigger";
export { readShorthandDecoder } from "./shorthand";
export {
  Delta,
  Invalidate,
  InvalidateKind,
  LIVE_PROTOCOL_VERSION,
  LiveMessage,
  LiveTopic,
  MUTABLE_LIVE_TOPICS,
  parseSessionTopic,
  buildSessionStreamTopic,
  buildSessionTapTopic,
  TapItem,
  isAppendOnlyLiveTopic,
  live,
  type AppendOnlyLiveTopic,
  type MutableLiveTopic,
  type SessionLiveTopic,
  type SessionTopicKind,
} from "./groups/live";
