/**
 * Plugins: what the binary was built with, what the user decided about each,
 * and what this boot made of it. The set is fixed at build time, so a listing
 * is the whole set and both endpoints answer the same shape. `status` is what
 * this process found and does not survive a restart; `enabled` and `config` do.
 */
import { Schema } from "effect";
import { PluginCapability, PluginId } from "@hercule/plugin-host";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { closedStruct } from "../closed";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Authenticated } from "../security";

/**
 * A plugin's own text has no bound of its own, yet is served on every listing
 * and kept in the log for months, so the bound is published here.
 */
export const MAX_PLUGIN_MESSAGE_LENGTH = 2048;

/** A message a plugin wrote, cut to what this API will carry. */
const PluginMessage = Schema.String.check(Schema.isMaxLength(MAX_PLUGIN_MESSAGE_LENGTH));

/** Re-exported from the package plugins are written against: one list, two readers. */
export { PluginCapability } from "@hercule/plugin-host";

/**
 * Each is decided from the manifest alone, before any plugin code runs, which
 * is what makes a broken plugin something the user reads about.
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
 * The document the settings form is generated from. An open record rather than
 * JSON, because that is what a JSON Schema node is: any keyword may appear.
 */
export const PluginConfigSchema = Schema.Record(Schema.String, Schema.Unknown);

/**
 * A definition's shape is its extension point's own, so it is carried as the
 * JSON the catalog holds rather than re-declared per extension point here.
 */
export const PluginContribution = Schema.Struct({
  extensionPoint: Schema.String,
  id: Schema.String,
  definition: Schema.Json,
});

export type PluginContribution = Schema.Schema.Type<typeof PluginContribution>;

/**
 * `configSchema` is absent for every refused plugin, because it is derived only
 * after the manifest is accepted: its absence says a form cannot be generated,
 * never which refusal it was. That is `status.reason`.
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
 * A key beside `config` is refused rather than dropped, so a client sending the
 * wrong shape is told instead of getting a silent 200.
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
