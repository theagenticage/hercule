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
  listChoiceFields,
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
  HarnessDefinition,
  HarnessWord,
  MAX_HARNESS_HOME_SEGMENT_LENGTH,
  HarnessProviderSupport,
  QualifiedContributionId,
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
  AccountKind,
  AccountSetupStep,
  AccountUsageDeclaration,
  CatalogSource,
  DefaultSelection,
  HarnessLoginStep,
  HarnessProbeCatalogSource,
  KeyCheck,
  ProviderApiCatalogSource,
  ProviderDefinition,
  type ParseCatalogBody,
  type ParseUsageBody,
} from "./providers";

// What a usage or catalog parser takes and returns, so a plugin names them without linking the protocol.
// `CatalogModel` is also exported as a schema, so a catalog parser can check what it builds.
export { CatalogModel } from "@hercule/protocol";
export type { Timestamp, UsageReading } from "@hercule/protocol";

export { checkEmittedEvent } from "./check-event";

export {
  EXTERNAL_REF_PATTERN,
  ISO_TIMESTAMP_PATTERN,
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
  MAX_SIGNAL_MATCH_FIELD_NAME_LENGTH,
  MAX_SIGNAL_MATCH_FIELDS,
  MAX_SIGNAL_TITLE_LENGTH,
  TASK_PRIORITIES,
  TaskPriority,
} from "./limits";

export {
  PluginError,
  registerConnectionType,
  registerEventSource,
  registerHarness,
  registerProvider,
  registerWorkflowAction,
  type ActivationContext,
  type Deactivate,
  type EventSourceRegistration,
  type KeyValueStore,
  type Plugin,
  type PluginSecrets,
  type HarnessRegistration,
  type ProviderRegistration,
  type ProviderRegistrationOptions,
  type RegistrationHost,
  type WorkflowActionRegistration,
} from "./plugin";
