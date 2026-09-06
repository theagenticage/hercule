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

export { configJsonSchema, UnsupportedConfigSchema } from "./config-schema";

export { AccessMode, DeclaredCapabilities, ProviderDefinition } from "./contributions";

export {
  PluginError,
  registerProvider,
  type ActivationContext,
  type Deactivate,
  type KeyValueStore,
  type Plugin,
  type PluginSecrets,
  type ProviderRegistration,
  type RegistrationHost,
} from "./plugin";
