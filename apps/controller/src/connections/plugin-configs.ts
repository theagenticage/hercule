/**
 * Reads a plugin's stored config. The plugins domain owns the plugins table and
 * provides this service.
 *
 * It is a service rather than a direct import of the plugins domain, because
 * the plugins domain already imports this one, and imports between the two must
 * point one way. The only value the connections domain reads through it is the
 * OAuth client id the user configured.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { SqlError } from "effect/unstable/sql/SqlError";

export class PluginConfigs extends Context.Service<
  PluginConfigs,
  { readonly of: (pluginId: string) => Effect.Effect<Schema.Json, SqlError> }
>()("hercule/controller/connections/PluginConfigs") {}
