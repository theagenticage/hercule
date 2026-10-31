import { Schema } from "effect";

/**
 * The version of the host API a plugin is built against. A plugin that
 * declares another version is refused at load, rather than run against an API
 * it does not know.
 *
 * - Version 3 changed `HarnessDefinition` (it declares the providers it runs and
 *   no longer has a config schema) and added `ProviderDefinition`.
 * - Version 4 made `defaultHarnessId` and the `method` of a `harness-login`
 *   step required, and added the `keyCheck` of an account kind. A plugin built
 *   against version 3 declares neither, so the host refuses it at load.
 * - Version 5 made `catalogSource` and `defaultSelection` required on
 *   `ProviderDefinition`. A provider plugin built against version 4 declares
 *   neither, so the host refuses it at load.
 */
export const HOST_API = 5;

/**
 * The named parts of the host API a plugin may request. Only some of them are
 * implemented so far, and the host keeps that list. The others are valid in a
 * manifest but refused at load, so a manifest never has to be rewritten as
 * they are implemented.
 */
export const PLUGIN_CAPABILITIES = [
  "harnesses",
  // The model provider's registration point.
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
 * The regular expression source of a plugin id, without anchors. A qualified
 * contribution id starts with a plugin id, so it is built from the same text.
 */
export const PLUGIN_ID_SOURCE = "[a-z0-9]+(-[a-z0-9]+)*";

/**
 * A plugin id: a lowercase slug. It is the namespace for the plugin's KV keys,
 * its secrets and its contribution ids, and it is written into the associated
 * data that binds a secret to its owner, so a separator or an empty string in
 * it would make one of those ambiguous.
 */
export const PluginId = Schema.String.check(
  Schema.isPattern(new RegExp(`^${PLUGIN_ID_SOURCE}$`), {
    title: "plugin id",
    description: "lowercase letters and digits, single dashes between them",
  }),
);

/**
 * The plugin's mark: SVG path `d` strings drawn on a fixed 16x16 viewBox, in
 * the theme's colour. It holds path data only, so a mark can carry no script,
 * style or colour. The host checks the strings when it loads the plugin: at
 * most 16 paths, and at most 4 KB of them together. It drops a mark that
 * fails the check rather than the plugin.
 */
export const PluginMark = Schema.Struct({ paths: Schema.Array(Schema.String) });

export type PluginMark = Schema.Schema.Type<typeof PluginMark>;

export const PluginManifest = Schema.Struct({
  /** Stable, and the namespace for this plugin's KV keys, secrets and contribution ids. */
  id: PluginId,
  displayName: Schema.String,
  hostApi: Schema.Int,
  capabilities: Schema.Array(PluginCapability),
  configSchema: SchemaValue,
  mark: Schema.optionalKey(PluginMark),
});

export type PluginManifest = Schema.Schema.Type<typeof PluginManifest>;
