/**
 * The `plugin.*` operations, and `workflowAction.query`, which lists the
 * workflow actions that the core and the plugins registered.
 *
 * A plugin, as a caller sees it, combines the user's settings (enabled,
 * config) with what this boot found (status, catalog rows). Only the settings
 * survive a restart. The set of plugins is fixed by the binary, so a listing
 * returns the whole set with no filter or paging, and reading one plugin
 * filters that listing.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createDecodeValidationError,
  createNotFoundError,
  createValidationError,
  PluginConfigureInput,
  type Forbidden,
  type NotFound,
  type PluginDetail,
  type Unauthenticated,
  type Validation,
  type WorkflowAction,
} from "@hercule/contract";
import { nowIso, withTransaction } from "../db";
import { currentStamp, requireGrant } from "../actor";
import { connectionStateRepository } from "../connections";
import { AuditLog } from "../events";
import { PluginHost } from "./host";
import { pluginRepository, readStoredStateOrDie } from "./repository";

type MoveKind =
  | "plugin.enabled"
  | "plugin.disabled"
  | "plugin.configured"
  | "plugin.retried"
  | "plugin.stateReset";

/**
 * The errors of a lifecycle change. The credential errors are included
 * because the grant check runs inside the method, so a built-in caller that
 * does not come through a transport is checked like a request.
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
  const connectionState = yield* connectionStateRepository;

  const details: Effect.Effect<
    ReadonlyArray<PluginDetail>,
    SqlError | Schema.SchemaError
  > = Effect.gen(function* () {
    const loaded = yield* host.loaded();
    const states = yield* repository.states();
    const contributions = yield* repository.contributions();
    return yield* Effect.forEach(loaded, (plugin) =>
      Effect.map(readStoredStateOrDie(states.get(plugin.id), plugin.id), (state): PluginDetail => ({
        ...plugin,
        ...state,
        contributions: (contributions.get(plugin.id) ?? []).map(
          ({ extensionPoint, id, definition }) => ({ extensionPoint, id, definition }),
        ),
      })),
    );
  });

  /** Reads one plugin without a grant check, for callers that already checked it. Fails with not found. */
  const readPluginOrFail = (
    id: string,
  ): Effect.Effect<PluginDetail, NotFound | SqlError | Schema.SchemaError> =>
    Effect.flatMap(details, (all) => {
      const found = all.find((detail) => detail.id === id);
      return found === undefined
        ? Effect.fail(createNotFoundError(`no plugin named ${id} is installed`))
        : Effect.succeed(found);
    });

  /**
   * Reads a plugin that a lifecycle change can act on. Fails with a
   * validation error for a `refused` plugin, which has no code running and no
   * catalog rows, so there is nothing to change.
   */
  const readMovablePluginOrFail = (
    id: string,
  ): Effect.Effect<PluginDetail, NotFound | Validation | SqlError | Schema.SchemaError> =>
    Effect.flatMap(readPluginOrFail(id), (detail) =>
      detail.status._tag === "refused"
        ? Effect.fail(
            createValidationError(
              [{ path: [], message: `the plugin ${id} was not loaded, so it cannot be changed` }],
              `the plugin ${id} was not loaded`,
            ),
          )
        : Effect.succeed(detail),
    );

  /**
   * Reads a plugin for a lifecycle change that ends by starting it. Fails
   * with a validation error when the plugin's `register` or teardown failed,
   * because it cannot start again in this process; only a restart clears
   * either.
   */
  const readRestartablePluginOrFail = (
    id: string,
  ): Effect.Effect<PluginDetail, NotFound | Validation | SqlError | Schema.SchemaError> =>
    Effect.gen(function* () {
      const detail = yield* readMovablePluginOrFail(id);
      if (yield* host.startable(id)) return detail;
      const message = `the plugin ${id} needs a controller restart before it can start again`;
      return yield* Effect.fail(createValidationError([{ path: [], message }], message));
    });

  /**
   * Writes a lifecycle change and its audit entry in one transaction, so the
   * log never records a change the database rolled back. The entry names the
   * plugin as its record, which tells live subscribers to refetch it.
   */
  const writeMove = (
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
            actor: yield* currentStamp,
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
        return yield* readPluginOrFail(id);
      }),

    /**
     * Returns every workflow action a step can call, with its input schema as
     * JSON Schema, and the Connection type of each action that acts through
     * one. Fails with `Forbidden` if the caller lacks the grant.
     */
    queryWorkflowActions: (): Effect.Effect<ReadonlyArray<WorkflowAction>, Forbidden> =>
      Effect.gen(function* () {
        yield* requireGrant("workflowAction.query");
        const actions = yield* host.listActiveWorkflowActions();
        return actions.map(({ id, displayName, description, runsIn, inputSchema, connection }) => ({
          id,
          displayName,
          description,
          runsIn,
          inputSchema,
          ...(connection === undefined ? {} : { connection }),
        }));
      }),

    enable: (id: string): Effect.Effect<PluginDetail, MoveError> =>
      Effect.gen(function* () {
        yield* requireGrant("plugin.enable");
        return yield* host.serialized(
          Effect.gen(function* () {
            const detail = yield* readRestartablePluginOrFail(id);
            if (detail.enabled) return detail;
            yield* writeMove(id, "plugin.enabled", (at) => repository.setEnabled(id, true, at));
            yield* host.refresh(id);
            return yield* readPluginOrFail(id);
          }),
        );
      }),

    /**
     * Disables a plugin. It is stopped before the flag is written, so nothing
     * is still running once its contributions read as disabled. This is the
     * one change allowed for a plugin that needs a restart, because turning it
     * off is how to deal with parts a failed teardown left running.
     */
    disable: (id: string): Effect.Effect<PluginDetail, MoveError> =>
      Effect.gen(function* () {
        yield* requireGrant("plugin.disable");
        return yield* host.serialized(
          Effect.gen(function* () {
            const detail = yield* readMovablePluginOrFail(id);
            if (!detail.enabled) return detail;
            yield* host.stop(id);
            yield* writeMove(id, "plugin.disabled", (at) => repository.setEnabled(id, false, at));
            return yield* readPluginOrFail(id);
          }),
        );
      }),

    /**
     * Stores a config and restarts the plugin with it. There is no live
     * reconfigure, so a plugin never sees its config change while it runs.
     * The config is validated before anything is stopped or written, so an
     * invalid form leaves a running plugin running.
     */
    configure: (id: string, input: PluginConfigureInput): Effect.Effect<PluginDetail, MoveError> =>
      Effect.gen(function* () {
        yield* requireGrant("plugin.configure");
        const { config } = yield* Effect.mapError(
          decodeConfigure(input),
          createDecodeValidationError,
        );
        return yield* host.serialized(
          Effect.gen(function* () {
            yield* readRestartablePluginOrFail(id);
            yield* host.validate(id, config);
            const stopped = yield* host.stop(id);
            yield* writeMove(id, "plugin.configured", (at) => repository.setConfig(id, config, at));
            if (stopped) yield* host.refresh(id);
            return yield* readPluginOrFail(id);
          }),
        );
      }),

    retry: (id: string): Effect.Effect<PluginDetail, MoveError> =>
      Effect.gen(function* () {
        yield* requireGrant("plugin.retry");
        return yield* host.serialized(
          Effect.gen(function* () {
            const detail = yield* readRestartablePluginOrFail(id);
            if (detail.status._tag !== "errored") {
              const message = `the plugin ${id} is not errored, so there is nothing to retry`;
              return yield* Effect.fail(createValidationError([{ path: [], message }], message));
            }
            yield* writeMove(id, "plugin.retried", () => Effect.void);
            yield* host.refresh(id);
            return yield* readPluginOrFail(id);
          }),
        );
      }),

    /**
     * Deletes everything a plugin stored and restarts it. Also allowed while
     * the plugin is inactive or errored, because leftover state is a likely
     * cause of either.
     *
     * The state of the plugin's Connections goes too. Stopping the plugin has
     * closed their ingest handles, and the controller daemon opens them again
     * once the plugin is active, so each starts from now.
     */
    resetState: (id: string): Effect.Effect<PluginDetail, MoveError> =>
      Effect.gen(function* () {
        yield* requireGrant("plugin.resetState");
        return yield* host.serialized(
          Effect.gen(function* () {
            yield* readRestartablePluginOrFail(id);
            const stopped = yield* host.stop(id);
            yield* writeMove(id, "plugin.stateReset", () =>
              Effect.andThen(repository.kvWipe(id), connectionState.wipePluginState(id)),
            );
            if (stopped) yield* host.refresh(id);
            return yield* readPluginOrFail(id);
          }),
        );
      }),
  };
});

export class Plugins extends Context.Service<Plugins, Effect.Success<typeof make>>()(
  "hercule/controller/plugins/Plugins",
) {}

export const PluginsLayer: Layer.Layer<
  Plugins,
  never,
  SqlClient.SqlClient | PluginHost | AuditLog
> = Layer.effect(Plugins)(make);
