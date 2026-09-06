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
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { notFound, validation, type NotFound, type Validation } from "@hydra/contract";
import { nowIso, withTransaction } from "../db";
import { USER_ACTOR } from "../actor";
import { AuditLog } from "../events";
import { PluginHost, type LoadedPlugin } from "./host";
import { pluginRepository, type Contribution } from "./repository";

/** One plugin, whole: the manifest, the user's intent and this boot's outcome. */
export interface PluginDetail extends LoadedPlugin {
  readonly enabled: boolean;
  readonly config: Schema.Json;
  readonly contributions: ReadonlyArray<Contribution>;
}

/** The audit kinds one of these moves appends. */
type MoveKind =
  | "plugin.enabled"
  | "plugin.disabled"
  | "plugin.configured"
  | "plugin.retried"
  | "plugin.stateReset";

/** What a write to one plugin can answer with, whichever move it was. */
type MoveError = NotFound | Validation | SqlError | Schema.SchemaError;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* pluginRepository;
  const host = yield* PluginHost;
  const audit = yield* AuditLog;

  const details: Effect.Effect<
    ReadonlyArray<PluginDetail>,
    SqlError | Schema.SchemaError
  > = Effect.gen(function* () {
    const loaded = yield* host.loaded();
    const states = yield* repository.states();
    const contributions = yield* repository.contributions();
    return yield* Effect.forEach(loaded, (plugin) => {
      const state = states.get(plugin.id);
      // Boot gives every plugin it lists a row, in the transaction that makes
      // it listed at all, so a plugin without one is a broken database rather
      // than a plugin whose settings are simply unknown.
      return state === undefined
        ? Effect.die(new Error(`The plugin ${plugin.id} has no stored row.`))
        : Effect.succeed({
            ...plugin,
            ...state,
            contributions: contributions.get(plugin.id) ?? [],
          });
    });
  });

  /** One plugin. An id no registry plugin carries is `not_found`. */
  const read = (
    id: string,
  ): Effect.Effect<PluginDetail, NotFound | SqlError | Schema.SchemaError> =>
    Effect.flatMap(details, (all) => {
      const found = all.find((detail) => detail.id === id);
      return found === undefined
        ? Effect.fail(notFound(`no plugin named ${id} is installed`))
        : Effect.succeed(found);
    });

  /**
   * The plugin a move is about, refusing one that was never loaded. A refused
   * plugin has no code running and no catalog rows, so there is nothing for
   * enable, configure, retry or reset to act on.
   */
  const target = (
    id: string,
  ): Effect.Effect<PluginDetail, NotFound | Validation | SqlError | Schema.SchemaError> =>
    Effect.flatMap(read(id), (detail) =>
      detail.status._tag === "refused"
        ? Effect.fail(
            validation(
              [{ path: [], message: `the plugin ${id} was not loaded, so it cannot be changed` }],
              `the plugin ${id} was not loaded`,
            ),
          )
        : Effect.succeed(detail),
    );

  /**
   * The plugin a move that ends in a start is about. A plugin whose `register`
   * or whose teardown failed cannot be started again in this process: the first
   * has no contributions to run against, the second has machinery still
   * running, and only a restart clears either.
   */
  const restartable = (id: string): Effect.Effect<PluginDetail, MoveError> =>
    Effect.gen(function* () {
      const detail = yield* target(id);
      if (yield* host.startable(id)) return detail;
      const message = `the plugin ${id} needs a controller restart before it can start again`;
      return yield* Effect.fail(validation([{ path: [], message }], message));
    });

  /**
   * One move's write set and the entry that records it, in one transaction: the
   * log never claims something the database rolled back. The entry names the
   * plugin as a record, which is what tells a live subscriber to refetch it.
   */
  const write = (
    id: string,
    kind: MoveKind,
    change: (at: string) => Effect.Effect<void, SqlError>,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const at = yield* nowIso;
      yield* withTransaction(
        sql,
        Effect.gen(function* () {
          yield* change(at);
          yield* audit.append({
            kind,
            actor: USER_ACTOR,
            payload: { pluginId: id },
            record: { topic: "plugin", id },
            at,
          });
        }),
      );
    });

  return {
    /** Every plugin compiled into this binary, in registry order. */
    query: (): Effect.Effect<ReadonlyArray<PluginDetail>, SqlError | Schema.SchemaError> => details,

    read,

    /** Lets a plugin run, and starts it. Enabling an enabled plugin changes nothing. */
    enable: (id: string): Effect.Effect<PluginDetail, MoveError> =>
      host.serialized(
        Effect.gen(function* () {
          const detail = yield* restartable(id);
          if (detail.enabled) return detail;
          yield* write(id, "plugin.enabled", (at) => repository.setEnabled(id, true, at));
          yield* host.refresh(id, { enabled: true, config: detail.config });
          return yield* read(id);
        }),
      ),

    /**
     * Stops a plugin and records that the user wants it stopped. The plugin is
     * stopped before the flag is written, so nothing of it is still running
     * once its contributions read as a disabled plugin's. It is the one move a
     * plugin needing a restart still accepts: the user's answer to leftover
     * machinery is usually to turn the thing off.
     */
    disable: (id: string): Effect.Effect<PluginDetail, MoveError> =>
      host.serialized(
        Effect.gen(function* () {
          const detail = yield* target(id);
          if (!detail.enabled) return detail;
          yield* host.stop(id);
          yield* write(id, "plugin.disabled", (at) => repository.setEnabled(id, false, at));
          return yield* read(id);
        }),
      ),

    /**
     * Stores a config and restarts the plugin on it. There is no hot
     * reconfigure: a plugin never observes its config changing while it runs.
     * The config is validated before anything is stopped or written, so a
     * rejected form leaves a running plugin running.
     */
    configure: (
      id: string,
      input: { readonly config: Schema.Json },
    ): Effect.Effect<PluginDetail, MoveError> =>
      host.serialized(
        Effect.gen(function* () {
          const detail = yield* restartable(id);
          yield* host.validate(id, input.config);
          const stopped = yield* host.stop(id);
          yield* write(id, "plugin.configured", (at) => repository.setConfig(id, input.config, at));
          if (stopped) yield* host.refresh(id, { enabled: detail.enabled, config: input.config });
          return yield* read(id);
        }),
      ),

    /**
     * Runs `activate` once more. Only an errored plugin can be retried, so the
     * button is never a second spelling of enable.
     */
    retry: (id: string): Effect.Effect<PluginDetail, MoveError> =>
      host.serialized(
        Effect.gen(function* () {
          const detail = yield* restartable(id);
          if (detail.status._tag !== "errored") {
            const message = `the plugin ${id} is not errored, so there is nothing to retry`;
            return yield* Effect.fail(validation([{ path: [], message }], message));
          }
          yield* write(id, "plugin.retried", () => Effect.void);
          yield* host.refresh(id, { enabled: detail.enabled, config: detail.config });
          return yield* read(id);
        }),
      ),

    /**
     * Throws away everything a plugin stored and starts it over. Allowed while
     * it is inactive or errored too: leftover state is a plausible cause of
     * both.
     */
    resetState: (id: string): Effect.Effect<PluginDetail, MoveError> =>
      host.serialized(
        Effect.gen(function* () {
          const detail = yield* restartable(id);
          const stopped = yield* host.stop(id);
          yield* write(id, "plugin.stateReset", () => repository.kvWipe(id));
          if (stopped) yield* host.refresh(id, { enabled: detail.enabled, config: detail.config });
          return yield* read(id);
        }),
      ),
  };
});

export class Plugins extends Context.Service<Plugins, Effect.Success<typeof make>>()(
  "hydra/controller/plugins/Plugins",
) {}

export const PluginsLayer: Layer.Layer<
  Plugins,
  never,
  SqlClient.SqlClient | PluginHost | AuditLog
> = Layer.effect(Plugins)(make);
