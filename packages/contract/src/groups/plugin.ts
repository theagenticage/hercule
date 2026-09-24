/**
 * Plugins: the plugins the binary was built with, whether the user enabled
 * each one, and what happened to each when this controller started. The set
 * is fixed at build time, so the list is always complete and both read
 * endpoints return the same shape. `status` describes this process only and
 * does not survive a restart; `enabled` and `config` do.
 */
import { Schema } from "effect";
import { PluginCapability, PluginId } from "@hercule/plugin-host";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { closedStruct } from "../closed";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Authenticated } from "../security";

/**
 * Text a plugin writes has no limit of its own, but it is returned in every
 * list and kept in the log for months, so the limit is declared here.
 */
export const MAX_PLUGIN_MESSAGE_LENGTH = 2048;

/** A message a plugin wrote, limited to the length this API accepts. */
const PluginMessage = Schema.String.check(Schema.isMaxLength(MAX_PLUGIN_MESSAGE_LENGTH));

/** Re-exported from the package plugins are written against, so both use the same list. */
export { PluginCapability } from "@hercule/plugin-host";

/**
 * Why the controller refused to load a plugin. Each reason is decided from the
 * manifest alone, before any plugin code runs, so a broken plugin shows up as
 * a status the user can read instead of a crash.
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

/** The state of a plugin in the controller process that handles this request. */
export const PluginStatus = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("active") }),
  Schema.Struct({ _tag: Schema.Literal("inactive") }),
  Schema.Struct({ _tag: Schema.Literal("errored"), message: PluginMessage }),
  Schema.Struct({ _tag: Schema.Literal("refused"), reason: PluginRefusalReason }),
]);

export type PluginStatus = Schema.Schema.Type<typeof PluginStatus>;

/**
 * The JSON Schema the settings form is generated from. Typed as an open record,
 * because any keyword may appear in a JSON Schema node.
 */
export const PluginConfigSchema = Schema.Record(Schema.String, Schema.Unknown);

/**
 * Each extension point defines the shape of its own definitions, so the
 * definition is carried as the JSON the catalog holds rather than declared
 * again here for each extension point.
 */
export const PluginContribution = Schema.Struct({
  extensionPoint: Schema.String,
  id: Schema.String,
  definition: Schema.Json,
});

export type PluginContribution = Schema.Schema.Type<typeof PluginContribution>;

/**
 * `configSchema` is absent for every refused plugin, because it is derived only
 * after the manifest is accepted. Its absence means a form cannot be generated;
 * the reason for the refusal is in `status.reason`.
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
 * A key other than `config` is rejected rather than ignored, so a client that
 * sends the wrong shape gets an error instead of a silent 200.
 */
export const PluginConfigureInput = closedStruct({ config: Schema.Json });

export type PluginConfigureInput = Schema.Schema.Type<typeof PluginConfigureInput>;

/** A plugin id in a route. Not a UUID: a plugin's id comes from its manifest. */
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
