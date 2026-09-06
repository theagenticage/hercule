/**
 * Plugins: what the binary was built with, what the user decided about each,
 * and what this boot made of it.
 *
 * The set is fixed at build time, so a listing is the whole set: no filter, no
 * paging, and reading one is the listing narrowed to a single item. Both answer
 * the same shape, because Settings shows the same card in a list and on its own.
 *
 * Status is what this process found and does not survive a restart; `enabled`
 * and `config` are what the user decided and do. A client that shows only one
 * of the two would be telling half the story, so both are on every plugin.
 */
import { Schema } from "effect";
import { PluginCapability, PluginId } from "@hydra/plugin-host";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { closedStruct } from "../closed";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Authenticated } from "../security";

/**
 * The longest plugin-written message this API carries. The text is a plugin's
 * own - what its hook failed with, what its config schema was rejected for -
 * and has no bound of its own, so the bound is here: it is served to a browser
 * on every listing and kept in the log for months.
 */
export const MAX_PLUGIN_MESSAGE_LENGTH = 2048;

/** A message a plugin wrote, cut to what this API will carry. */
const PluginMessage = Schema.String.check(Schema.isMaxLength(MAX_PLUGIN_MESSAGE_LENGTH));

/**
 * The capability names a manifest may ask for. Declared by the package plugins
 * are written against, so the API and the plugin author read one list.
 */
export { PluginCapability } from "@hydra/plugin-host";

/**
 * Why a plugin was not loaded. Each of the three is decided from the manifest
 * alone, before any of the plugin's own code runs, which is what makes a broken
 * plugin something the user reads about rather than something that breaks a
 * boot.
 */
export const PluginRefusalReason = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("hostApi"),
    expected: Schema.Int,
    actual: Schema.Int,
  }),
  Schema.Struct({
    kind: Schema.Literal("unimplementedCapability"),
    capability: PluginCapability,
  }),
  Schema.Struct({
    kind: Schema.Literal("unsupportedConfigSchema"),
    message: PluginMessage,
  }),
]);

export type PluginRefusalReason = Schema.Schema.Type<typeof PluginRefusalReason>;

/** Where a plugin stands in the controller process answering this request. */
export const PluginStatus = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("active") }),
  Schema.Struct({ _tag: Schema.Literal("inactive") }),
  Schema.Struct({ _tag: Schema.Literal("errored"), message: PluginMessage }),
  Schema.Struct({ _tag: Schema.Literal("refused"), reason: PluginRefusalReason }),
]);

export type PluginStatus = Schema.Schema.Type<typeof PluginStatus>;

/**
 * A JSON Schema document, as the settings form is generated from. It is
 * declared as an open record rather than as JSON, because that is what a JSON
 * Schema node is - any keyword may appear on it - and because the host derives
 * it from the plugin's own Effect Schema, which never crosses the wire.
 */
export const PluginConfigSchema = Schema.Record(Schema.String, Schema.Unknown);

/**
 * One entry in the contribution catalog, as the plugin registered it. The
 * definition's shape is the extension point's own, so it is carried as the JSON
 * the catalog holds rather than re-declared per extension point here.
 */
export const PluginContribution = Schema.Struct({
  extensionPoint: Schema.String,
  id: Schema.String,
  definition: Schema.Json,
});

export type PluginContribution = Schema.Schema.Type<typeof PluginContribution>;

/**
 * One plugin, whole.
 *
 * `configSchema` is absent for every plugin that was turned away, whichever of
 * the three reasons it was: the schema is derived after the manifest is
 * accepted, so a refused plugin never has one. Its absence therefore says a
 * form cannot be generated, and never which refusal it was - that is what
 * `status.reason` is for.
 */
export const PluginDetail = Schema.Struct({
  id: PluginId,
  displayName: Schema.String,
  hostApi: Schema.Int,
  capabilities: Schema.Array(PluginCapability),
  enabled: Schema.Boolean,
  status: PluginStatus,
  configSchema: Schema.optionalKey(PluginConfigSchema),
  config: Schema.Json,
  contributions: Schema.Array(PluginContribution),
});

export type PluginDetail = Schema.Schema.Type<typeof PluginDetail>;

/**
 * What configuring a plugin takes. The config is validated against the plugin's
 * own schema by the host, which is the only place that schema exists; a key
 * beside `config` is refused rather than dropped, so a client sending the wrong
 * shape is told instead of getting a silent 200.
 */
export const PluginConfigureInput = closedStruct({ config: Schema.Json });

export type PluginConfigureInput = Schema.Schema.Type<typeof PluginConfigureInput>;

/** A plugin id in a route. Not a UUID: a plugin is named by its manifest. */
const params = { id: PluginId };

export const plugin = HttpApiGroup.make("plugin")
  .add(
    HttpApiEndpoint.get("query", "/plugins", {
      success: Schema.Array(PluginDetail),
      error: [Unauthenticated, Forbidden, Internal],
    }),
    HttpApiEndpoint.get("read", "/plugins/:id", {
      params,
      success: PluginDetail,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("enable", "/plugins/:id/enable", {
      params,
      success: PluginDetail,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("disable", "/plugins/:id/disable", {
      params,
      success: PluginDetail,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("retry", "/plugins/:id/retry", {
      params,
      success: PluginDetail,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("resetState", "/plugins/:id/reset-state", {
      params,
      success: PluginDetail,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.put("configure", "/plugins/:id/config", {
      params,
      payload: PluginConfigureInput,
      success: PluginDetail,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
  )
  .middleware(Authenticated);
