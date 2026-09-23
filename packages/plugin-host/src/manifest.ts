import { Schema } from "effect";

/**
 * The version of the host API a plugin is built against. A plugin that
 * declares another version is refused at load, rather than run against an API
 * it does not know.
 */
export const HOST_API = 1;

/**
 * The named parts of the host API a plugin may request. Only some of them are
 * implemented so far, and the host keeps that list. The others are valid in a
 * manifest but refused at load, so a manifest never has to be rewritten as
 * they are implemented.
 */
export const PLUGIN_CAPABILITIES = [
  "providers",
  "channels",
  "event-sources",
  "workflow-actions",
  "connections",
  "events",
  "notifications",
  "resources",
  "secrets",
  "kv",
  "public-api",
] as const;

export const PluginCapability = Schema.Literals(PLUGIN_CAPABILITIES);

export type PluginCapability = Schema.Schema.Type<typeof PluginCapability>;

/**
 * A live Effect Schema passed across the host boundary. It is the only thing a
 * plugin passes to the host that is not plain data: the host derives JSON
 * Schema from it and decodes stored config with it, and neither is possible
 * from JSON alone.
 */
export const SchemaValue = Schema.declare(Schema.isSchema);

/**
 * A plugin id: a lowercase slug. It is the namespace for the plugin's KV keys,
 * its secrets and its contribution ids, and it is written into the associated
 * data that binds a secret to its owner, so a separator or an empty string in
 * it would make one of those ambiguous.
 */
export const PluginId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    title: "plugin id",
    description: "lowercase letters and digits, single dashes between them",
  }),
);

export const PluginManifest = Schema.Struct({
  /** Stable, and the namespace for this plugin's KV keys, secrets and contribution ids. */
  id: PluginId,
  displayName: Schema.String,
  hostApi: Schema.Int,
  capabilities: Schema.Array(PluginCapability),
  configSchema: SchemaValue,
});

export type PluginManifest = Schema.Schema.Type<typeof PluginManifest>;
