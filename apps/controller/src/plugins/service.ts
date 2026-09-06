/**
 * The `plugin.*` operations.
 *
 * A plugin as a caller sees it is two things joined: what the user decided
 * (enabled, config) and what this boot found (status, and the contributions
 * that made it into the catalog). Neither half is complete on its own, and only
 * the first survives a restart.
 *
 * The set of plugins is fixed by the binary, so a listing is the whole set with
 * no filter and no paging, and reading one is the listing narrowed: a handful
 * of rows either way, and one code path.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { notFound, type NotFound } from "@hydra/contract";
import { PluginHost, type LoadedPlugin } from "./host";
import { pluginRepository, type Contribution } from "./repository";

/** One plugin, whole: the manifest, the user's intent and this boot's outcome. */
export interface PluginDetail extends LoadedPlugin {
  readonly enabled: boolean;
  readonly config: Schema.Json;
  readonly contributions: ReadonlyArray<Contribution>;
}

const make = Effect.gen(function* () {
  const repository = yield* pluginRepository;
  const host = yield* PluginHost;

  const details: Effect.Effect<
    ReadonlyArray<PluginDetail>,
    SqlError | Schema.SchemaError
  > = Effect.gen(function* () {
    const loaded = yield* host.loaded();
    const states = yield* repository.states();
    const contributions = yield* repository.contributions();
    // Boot gives every plugin it lists a row, in the transaction that makes it
    // listed at all, so there is no plugin here without one.
    return loaded.map((plugin) => ({
      ...plugin,
      ...states.get(plugin.id)!,
      contributions: contributions.get(plugin.id) ?? [],
    }));
  });

  return {
    /** Every plugin compiled into this binary, in registry order. */
    query: (): Effect.Effect<ReadonlyArray<PluginDetail>, SqlError | Schema.SchemaError> => details,

    /** One plugin. An id no registry plugin carries is `not_found`. */
    read: (id: string): Effect.Effect<PluginDetail, NotFound | SqlError | Schema.SchemaError> =>
      Effect.flatMap(details, (all) => {
        const found = all.find((detail) => detail.id === id);
        return found === undefined
          ? Effect.fail(notFound(`no plugin named ${id} is installed`))
          : Effect.succeed(found);
      }),
  };
});

export class Plugins extends Context.Service<Plugins, Effect.Success<typeof make>>()(
  "hydra/controller/plugins/Plugins",
) {}

export const PluginsLayer: Layer.Layer<Plugins, never, SqlClient.SqlClient | PluginHost> =
  Layer.effect(Plugins)(make);
