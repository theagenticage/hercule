import { Schema } from "effect";
import { SchemaValue } from "./manifest";

/** How much of a session a caller may act on without being asked. */
export const AccessMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);

export type AccessMode = Schema.Schema.Type<typeof AccessMode>;

const Support = Schema.Literals(["native", "unsupported"]);

/**
 * Static facts about the pinned harness version behind a provider. Every value
 * is a fact, never a fallback: what an unsupported mode degrades to is the
 * controller's policy, so nothing here says it.
 */
export const DeclaredCapabilities = Schema.Struct({
  /** `unsupported` means input to a busy session is queued by the controller. */
  steering: Support,
  fork: Support,
  modelSwitch: Schema.Literals(["in-session", "new-session"]),
  accessModes: Schema.Record(AccessMode, Support),
  mcpPassthrough: Support,
  disallowedTools: Support,
  structuredOutput: Schema.Literals(["supported", "unsupported"]),
});

export type DeclaredCapabilities = Schema.Schema.Type<typeof DeclaredCapabilities>;

/**
 * How long a provider's id and display name may be. Both reach columns and both
 * reach the wire: the display name is what the controller names the provider's
 * first instance, and the id is stored on every instance that routes to it. A
 * plugin that overruns either is refused at registration rather than writing a
 * row nothing can read back.
 */
export const MAX_PROVIDER_NAME_LENGTH = 128;

const ProviderName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_PROVIDER_NAME_LENGTH),
);

/**
 * A provider's static self-description, which is the whole of what a provider
 * plugin contributes. `defaultConfig` is the value the plugin's own function
 * already returned: a function would not survive the crossing into the catalog.
 */
export const ProviderDefinition = Schema.Struct({
  id: ProviderName,
  displayName: ProviderName,
  /**
   * The harness's own name on `PATH`. A machine reports which binaries it has
   * by that name, so this is what joins a runner's facts to an instance; the
   * provider that drives the binary is the one thing that knows it.
   */
  binaryName: ProviderName,
  /** Several accounts of one harness, kept apart by per-instance config dirs. */
  supportsMultipleInstances: Schema.Boolean,
  /** Per-instance logical settings only: environment and model defaults, never paths. */
  configSchema: SchemaValue,
  defaultConfig: Schema.Json,
  declared: DeclaredCapabilities,
});

export type ProviderDefinition = Schema.Schema.Type<typeof ProviderDefinition>;
