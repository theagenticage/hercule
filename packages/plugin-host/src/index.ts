/**
 * The surface a plugin programs against: its manifest, its two hooks, the
 * capability-sliced services the host hands them, and the contributions they
 * register. A plugin package depends on this and on `effect`, and reaches no
 * controller internal, so the same plugin runs out-of-process later.
 */
export {
  HOST_API,
  PLUGIN_CAPABILITIES,
  PluginCapability,
  PluginId,
  PluginManifest,
  SchemaValue,
} from "./manifest";

export {
  deriveConfigJsonSchema,
  decodeAgainst,
  secret,
  listSecretFields,
  excludeSecretFields,
  UnsupportedConfigSchema,
} from "./config-schema";

export {
  ConnectionStatus,
  ConnectionType,
  ConnectionUnavailable,
  ConnectionValidationFailed,
  CredentialField,
  OAuthDeclaration,
  SetupStep,
  type ConnectionRegistration,
  type ConnectionReport,
  type ConnectionsRuntime,
  type ConnectionSummary,
  type ConnectionTypeContribution,
} from "./connections";

export {
  ActionError,
  DeclaredCapabilities,
  EventSourceNames,
  MAX_CONTRIBUTION_NAME_LENGTH,
  ProviderDefinition,
  WorkflowActionNames,
  type ActionContext,
  type EventKindDeclaration,
  type EventSourceDefinition,
  type WorkflowActionContribution,
} from "./contributions";

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
