/**
 * Tells whether a plugin is running. The plugins domain owns that state and
 * provides this service.
 *
 * It is a service rather than a direct import of the plugins domain, for the
 * reason `PluginConfigs` gives: the plugins domain already imports this one,
 * and imports between the two must point one way.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export class ActivePlugins extends Context.Service<
  ActivePlugins,
  {
    /**
     * Returns whether the plugin is running: enabled, and activated without
     * an error. A plugin that is disabled or failed to start is not.
     */
    readonly isActive: (pluginId: string) => Effect.Effect<boolean>;
  }
>()("hercule/controller/connections/ActivePlugins") {}
