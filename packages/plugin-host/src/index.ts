/**
 * The API a plugin is written against: its manifest, its two hooks, the
 * services the host passes to them (one per granted capability), and the
 * contributions they register. A plugin package depends only on this and on
 * `effect`, and uses no controller internals, so the same plugin can later run
 * in a separate process.
 */
export {
  HOST_API,
  PLUGIN_CAPABILITIES,
  PluginCapability,
  PluginId,
  PluginManifest,
  PluginMark,
  SchemaValue,
} from "./manifest";

export {
  deriveConfigJsonSchema,
  decodeAgainst,
  secret,
  listSecretFields,
  listChoiceFields,
  excludeSecretFields,
  UnsupportedConfigSchema,
} from "./config-schema";

export {
  ConnectionStatus,
  ConnectionType,
  ConnectionUnavailable,
  ConnectionValidationFailed,
  CredentialField,
  DeviceDeclaration,
  OAuthDeclaration,
  SetupStep,
  type ConfigChoice,
  type ConnectionRegistration,
  type ConnectionReport,
  type ConnectionsRuntime,
  type ConnectionSummary,
  type ConnectionTypeContribution,
  type ExternalAccount,
} from "./connections";

export {
  ActionError,
  AuthError,
  BINDING_PLACES,
  BindingPlace,
  DescribeLinePart,
  DeclaredCapabilities,
  EventSourceNames,
  FeedDeclaration,
  MAX_CONTRIBUTION_NAME_LENGTH,
  MAX_EMITTED_FIELD_BYTES,
  ProviderDefinition,
  SignalDraft,
  SignalDraftAction,
  WorkflowActionNames,
  type ActionContext,
  type AnswerAction,
  type AnswerPlace,
  type IngestConnection,
  type ConnectionResources,
  type EmittedEvent,
  type EventKindDeclaration,
  type EventSourceContribution,
  type IngestContext,
  type IngestHandle,
  type LinkedResource,
  type OpenSignal,
  type PollResult,
  type SignalBuildContext,
  type SignalEndDeclaration,
  type SignalKindDeclaration,
  type SignalMatchField,
  type StoredEvent,
  type WorkflowActionContribution,
  type WorkflowStepAction,
} from "./contributions";

export {
  EXTERNAL_REF_PATTERN,
  MAX_BLOCK_MESSAGES,
  MAX_BLOCK_NAME_LENGTH,
  MAX_BLOCK_URL_LENGTH,
  MAX_CHECK_LOG_LENGTH,
  MAX_CHECK_LOG_LINES,
  MAX_CHECK_ROWS,
  MAX_DEDUP_KEY_LENGTH,
  MAX_EVENT_AUTHOR_LENGTH,
  MAX_EVENT_SYSTEM_LENGTH,
  MAX_EVENT_TITLE_LENGTH,
  MAX_EVENT_URL_LENGTH,
  MAX_EXTERNAL_REF_LENGTH,
  MAX_MESSAGE_TEXT_LENGTH,
  MAX_SIGNAL_BYTES,
  MAX_SIGNAL_TITLE_LENGTH,
  TASK_PRIORITIES,
  TaskPriority,
} from "./limits";

export {
  PluginError,
  registerConnectionType,
  registerEventSource,
  registerProvider,
  registerWorkflowAction,
  type ActivationContext,
  type Deactivate,
  type EventSourceRegistration,
  type KeyValueStore,
  type Plugin,
  type PluginSecrets,
  type ProviderRegistration,
  type RegistrationHost,
  type WorkflowActionRegistration,
} from "./plugin";
