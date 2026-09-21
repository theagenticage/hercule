import { Schema } from "effect";
import { AccessMode } from "@hercule/protocol";
import { SchemaValue } from "./manifest";

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
 * Ids and display names reach both columns and the wire, so an overrun is
 * refused at registration rather than written as a row nothing can read back.
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
  /** The harness's own name on `PATH`, which is what joins a runner's facts to an instance. */
  binaryName: ProviderName,
  /** Several accounts of one harness, kept apart by per-instance config dirs. */
  supportsMultipleInstances: Schema.Boolean,
  /** Per-instance logical settings only: environment and model defaults, never paths. */
  configSchema: SchemaValue,
  defaultConfig: Schema.Json,
  declared: DeclaredCapabilities,
});

export type ProviderDefinition = Schema.Schema.Type<typeof ProviderDefinition>;

/**
 * One event kind, as the plugin that emits it declares it: what the payload of
 * such an event must be, and one line saying what the event means. The host
 * derives JSON Schema from the schema for the catalog and keeps the schema
 * itself, which is what an emitted payload is read against.
 */
export interface EventKindDeclaration {
  readonly description: string;
  readonly schema: Schema.Top;
}

/**
 * What a plugin contributes as a source of events: the bare word it calls
 * itself, the Connection type its events arrive through, and every kind it can
 * emit. The host qualifies the bare word with the plugin's id, so two plugins
 * may each call themselves `github` and still name two different sources.
 *
 * Each kind's name carries the plugin's id as its first segment, which makes a
 * kind unique across plugins and lets a reader of the catalog find the owner of
 * a kind without a second column. The host refuses a kind that does not.
 */
export interface EventSourceDefinition {
  readonly id: string;
  readonly connectionType: string;
  readonly kinds: Record<string, EventKindDeclaration>;
}
