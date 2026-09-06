/**
 * The `plugin.*` operations.
 *
 * A plugin as a caller sees it joins what the user decided (enabled, config)
 * with what this boot found (status, catalog rows); only the first survives a
 * restart. The set is fixed by the binary, so a listing is the whole set with
 * no filter and no paging, and reading one is that listing narrowed.
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

type MoveKind =
  | "plugin.enabled"
  | "plugin.disabled"
  | "plugin.configured"
  | "plugin.retried"
  | "plugin.stateReset";

/**
 * The credential failures are here because the grant check runs inside the
 * method, so a built-in caller reaching no transport is refused as a request is.
 */
type MoveError =
  Unauthenticated | Forbidden | NotFound | Validation | SqlError | Schema.SchemaError;

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
        contributions: (contributions.get(plugin.id) ?? []).map(
          ({ extensionPoint, id, definition }) => ({ extensionPoint, id, definition }),
        ),
      })),
    );
  });

  /** One plugin, without the grant check: a move has already been checked once. */
  const one = (id: string): Effect.Effect<PluginDetail, NotFound | SqlError | Schema.SchemaError> =>
    Effect.flatMap(details, (all) => {
      const found = all.find((detail) => detail.id === id);
      return found === undefined
        ? Effect.fail(notFound(`no plugin named ${id} is installed`))
        : Effect.succeed(found);
    });

  /**
   * A refused plugin has no code running and no catalog rows, so there is
   * nothing for any move to act on.
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
   * For a move that ends in a start. A plugin whose `register` or teardown
   * failed cannot start again in this process; only a restart clears either.
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
   * The write set and its audit entry in one transaction, so the log never
   * claims what the database rolled back. Naming the plugin as a record is what
   * tells a live subscriber to refetch it.
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
    query: (): Effect.Effect<ReadonlyArray<PluginDetail>, ReadError> =>
      Effect.gen(function* () {
        yield* requireGrant("plugin.query");
        return yield* details;
      }),

    read: (id: string): Effect.Effect<PluginDetail, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("plugin.read");
        return yield* one(id);
      }),

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
     * Stopped before the flag is written, so nothing is still running once its
     * contributions read as a disabled plugin's. The one move a plugin needing
     * a restart still accepts: turning it off is the answer to leftover
     * machinery.
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
     * Stores a config and restarts the plugin on it: there is no hot
     * reconfigure, so a plugin never observes its config changing while it
     * runs. Validated before anything is stopped or written, so a rejected form
     * leaves a running plugin running.
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
     * inactive or errored too: leftover state is a plausible cause of both.
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
