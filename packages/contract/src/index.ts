/**
 * `@hercule/contract`: the public API declared once, in Effect Schema.
 *
 * The controller derives its routes and its request validation from `api`, the
 * CLI and `client-core` derive their client from it, and the OpenAPI document
 * is generated from it. `OPERATIONS` is the route and grant table every 403 and
 * every `hercule ... --help` reads.
 */
/** Version of the public API surface this build speaks. */
export const API_VERSION = 1;

export { api } from "./api";

export {
  ALL_OPERATIONS,
  API_PREFIX,
  OPERATIONS,
  isOperationId,
  requirementOf,
  type Method,
  type Operation,
  type OperationId,
  type Requirement,
} from "./operations";

export { ALL_GRANTS, GRANT_FAMILIES, GrantSchema, type Grant, type GrantFamily } from "./grants";

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
  capExceeded,
  conflict,
  forbidden,
  internal,
  invalidState,
  issuesOf,
  notFound,
  unauthenticated,
  validation,
  validationOf,
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
  sortFieldsOf,
  sortParam,
} from "./pagination";

export { ACCESS_MODE_CHAIN, nearestSupportedAccessMode } from "./access-modes";

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

/** The form-validation interface the schemas above answer to. */
export type { StandardSchemaV1 } from "effect/StandardSchema";

export { Actor, ExternalRef, Id, MAX_EXTERNAL_REF_LENGTH, NullableActor, Timestamp } from "./ids";

export { Authenticated, SetupToken } from "./security";

export { SetupPayload, SetupResult, SetupState } from "./groups/setup";
export { LoginPayload, LoginResult, WsTicket } from "./groups/auth";
export { ApiKey, MintedApiKey } from "./groups/api-key";
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
  ApprovalDecision,
  MAX_PROMPT_LENGTH,
  MAX_SPAWN_CHECKOUTS,
  OpenRequest,
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
  TaskFilter,
  TaskPriority,
  TaskStatus,
  TaskUpdateInput,
} from "./groups/task";
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
  EmitPayload,
  Emitted,
  EnrichPayload,
  EVENT_SORT_FIELDS,
  Event,
  EventId,
  MAX_DEDUP_KEY_LENGTH,
  MAX_EVENT_KIND_LENGTH,
  MAX_EVENT_SYSTEM_LENGTH,
  MAX_EVENT_URL_LENGTH,
} from "./groups/event";
export {
  Delta,
  Invalidate,
  InvalidateKind,
  LIVE_PROTOCOL_VERSION,
  LiveMessage,
  LiveTopic,
  MUTABLE_LIVE_TOPICS,
  parseSessionTopic,
  sessionStreamTopic,
  sessionTapTopic,
  TapItem,
  isAppendOnlyLiveTopic,
  live,
  type AppendOnlyLiveTopic,
  type MutableLiveTopic,
  type SessionLiveTopic,
  type SessionTopicKind,
} from "./groups/live";
