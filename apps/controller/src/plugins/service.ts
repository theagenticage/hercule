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
import {
  notFound,
  PluginConfigureInput,
  validation,
  validationOf,
  type Forbidden,
  type NotFound,
  type PluginDetail,
  type Unauthenticated,
  type Validation,
} from "@hydra/contract";
import { nowIso, withTransaction } from "../db";
import { requireGrant, USER_ACTOR } from "../actor";
import { AuditLog } from "../events";
import { PluginHost } from "./host";
import { pluginRepository, storedState } from "./repository";

/** The audit kinds one of these moves appends. */
type MoveKind =
  | "plugin.enabled"
  | "plugin.disabled"
  | "plugin.configured"
  | "plugin.retried"
  | "plugin.stateReset";

/**
 * What a write to one plugin can answer with, whichever move it was.
 *
 * The credential failures are part of it because the grant check runs inside
 * the method rather than in the handler, so a built-in caller reaching no
 * transport is refused the same way a request is. They are the channel the
 * published operation declares, which is why both are named although only one
 * of them is reached from here.
 */
type MoveError =
  Unauthenticated | Forbidden | NotFound | Validation | SqlError | Schema.SchemaError;

/** The same, for the two reads. */
type ReadError = Unauthenticated | Forbidden | SqlError | Schema.SchemaError;

const decodeConfigure = Schema.decodeUnknownEffect(PluginConfigureInput);

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
    return yield* Effect.forEach(loaded, (plugin) =>
      Effect.map(storedState(states.get(plugin.id), plugin.id), (state): PluginDetail => ({
        ...plugin,
        ...state,
        // The catalog's own rows carry the owner's enabled flag as well,
        // which a caller reads off the plugin these rows belong to.
        contributions: (contributions.get(plugin.id) ?? []).map(
          ({ extensionPoint, id, definition }) => ({ extensionPoint, id, definition }),
        ),
      })),
    );
  });

  /**
   * One plugin, without the grant check: what a move reads back after it has
   * already been checked. The gate belongs on what a caller asks for, and a
   * move asks once.
   */
  const one = (id: string): Effect.Effect<PluginDetail, NotFound | SqlError | Schema.SchemaError> =>
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
    Effect.flatMap(one(id), (detail) =>
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
  const restartable = (
    id: string,
  ): Effect.Effect<PluginDetail, NotFound | Validation | SqlError | Schema.SchemaError> =>
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
    query: (): Effect.Effect<ReadonlyArray<PluginDetail>, ReadError> =>
      Effect.gen(function* () {
        yield* requireGrant("plugin.query");
        return yield* details;
      }),

    /** One plugin. An id no registry plugin carries is `not_found`. */
    read: (id: string): Effect.Effect<PluginDetail, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("plugin.read");
        return yield* one(id);
      }),

    /** Lets a plugin run, and starts it. Enabling an enabled plugin changes nothing. */
    enable: (id: string): Effect.Effect<PluginDetail, MoveError> =>
      Effect.gen(function* () {
        yield* requireGrant("plugin.enable");
        return yield* host.serialized(
          Effect.gen(function* () {
            const detail = yield* restartable(id);
            if (detail.enabled) return detail;
            yield* write(id, "plugin.enabled", (at) => repository.setEnabled(id, true, at));
            yield* host.refresh(id);
            return yield* one(id);
          }),
        );
      }),

    /**
     * Stops a plugin and records that the user wants it stopped. The plugin is
     * stopped before the flag is written, so nothing of it is still running
     * once its contributions read as a disabled plugin's. It is the one move a
     * plugin needing a restart still accepts: the user's answer to leftover
     * machinery is usually to turn the thing off.
     */
    disable: (id: string): Effect.Effect<PluginDetail, MoveError> =>
      Effect.gen(function* () {
        yield* requireGrant("plugin.disable");
        return yield* host.serialized(
          Effect.gen(function* () {
            const detail = yield* target(id);
            if (!detail.enabled) return detail;
            yield* host.stop(id);
            yield* write(id, "plugin.disabled", (at) => repository.setEnabled(id, false, at));
            return yield* one(id);
          }),
        );
      }),

    /**
     * Stores a config and restarts the plugin on it. There is no hot
     * reconfigure: a plugin never observes its config changing while it runs.
     * The config is validated before anything is stopped or written, so a
     * rejected form leaves a running plugin running.
     *
     * The payload is decoded here rather than trusted, because a built-in
     * caller reaches these methods directly and the shape is the same rule
     * either way.
     */
    configure: (id: string, input: PluginConfigureInput): Effect.Effect<PluginDetail, MoveError> =>
      Effect.gen(function* () {
        yield* requireGrant("plugin.configure");
        const { config } = yield* Effect.mapError(decodeConfigure(input), validationOf);
        return yield* host.serialized(
          Effect.gen(function* () {
            yield* restartable(id);
            yield* host.validate(id, config);
            const stopped = yield* host.stop(id);
            yield* write(id, "plugin.configured", (at) => repository.setConfig(id, config, at));
            if (stopped) yield* host.refresh(id);
            return yield* one(id);
          }),
        );
      }),

    /**
     * Runs `activate` once more. Only an errored plugin can be retried, so the
     * button is never a second spelling of enable.
     */
    retry: (id: string): Effect.Effect<PluginDetail, MoveError> =>
      Effect.gen(function* () {
        yield* requireGrant("plugin.retry");
        return yield* host.serialized(
          Effect.gen(function* () {
            const detail = yield* restartable(id);
            if (detail.status._tag !== "errored") {
              const message = `the plugin ${id} is not errored, so there is nothing to retry`;
              return yield* Effect.fail(validation([{ path: [], message }], message));
            }
            yield* write(id, "plugin.retried", () => Effect.void);
            yield* host.refresh(id);
            return yield* one(id);
          }),
        );
      }),

    /**
     * Throws away everything a plugin stored and starts it over. Allowed while
     * it is inactive or errored too: leftover state is a plausible cause of
     * both.
     */
    resetState: (id: string): Effect.Effect<PluginDetail, MoveError> =>
      Effect.gen(function* () {
        yield* requireGrant("plugin.resetState");
        return yield* host.serialized(
          Effect.gen(function* () {
            yield* restartable(id);
            const stopped = yield* host.stop(id);
            yield* write(id, "plugin.stateReset", () => repository.kvWipe(id));
            if (stopped) yield* host.refresh(id);
            return yield* one(id);
          }),
        );
      }),
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
