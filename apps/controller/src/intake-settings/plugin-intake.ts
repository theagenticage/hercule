/**
 * Reads the Intake settings a plugin gives at its own level. The plugins
 * domain owns the plugin table and the plugin's declared kinds, and provides
 * this service.
 *
 * It is a service rather than a direct import of the plugins domain, because
 * the plugins domain already imports the connections domain, and imports
 * between the two must point one way. The connections domain and the
 * controller daemon read a plugin's level through it, and put a Connection's
 * own choices on top.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { IntakeSettings, Validation } from "@hercule/contract";
import type { SqlError } from "effect/unstable/sql/SqlError";

export class PluginIntake extends Context.Service<
  PluginIntake,
  {
    /**
     * Returns the value in effect at the plugin's level for every kind the
     * plugin declares: its default, or the user's choice for the plugin. Both
     * lists are empty for a plugin that declares no kinds, or that was not
     * loaded. A disabled plugin still lists its kinds.
     */
    readonly read: (pluginId: string) => Effect.Effect<IntakeSettings, SqlError>;

    /**
     * Returns the same settings as `read`, for a caller that is about to
     * write the level above. Fails with `validation` when the plugin did not
     * load, because its kinds are unknown and the write could not be checked.
     */
    readonly readBeforeWrite: (
      pluginId: string,
    ) => Effect.Effect<IntakeSettings, Validation | SqlError>;
  }
>()("hercule/controller/intake-settings/PluginIntake") {}
