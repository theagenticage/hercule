/**
 * A plugin's stored config, as the domain that owns the plugins table reads it.
 *
 * A service rather than a call into that domain, because the plugin host reads
 * this domain: everything between the two points one way, and the one column
 * wanted here - the client id the user configured - comes back through here.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { SqlError } from "effect/unstable/sql/SqlError";

export class PluginConfigs extends Context.Service<
  PluginConfigs,
  { readonly of: (pluginId: string) => Effect.Effect<Schema.Json, SqlError> }
>()("hercule/controller/connections/PluginConfigs") {}
