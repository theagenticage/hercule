import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * The port through which `Plugins` reports that a plugin was enabled,
 * disabled, configured, retried or reset. The workflows domain listens,
 * because a stored workflow that uses the plugin may stop validating, or
 * validate again. It is declared here and implemented in the controller
 * daemon, because the workflows domain depends on this one.
 *
 * `Plugins` calls it after the change has committed, while it still holds
 * the host's lifecycle permit, so the implementation must not take that
 * permit. It never fails: the implementation logs its own failure.
 */
export class PluginObserver extends Context.Service<
  PluginObserver,
  {
    /** Reports that a plugin's runtime status may have changed. */
    readonly pluginStatusChanged: () => Effect.Effect<void>;
  }
>()("hercule/controller/plugins/PluginObserver") {}
