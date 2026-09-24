/**
 * The `plugin.*` operations, and `workflowAction.query`, which lists the
 * workflow actions that the core and the plugins registered.
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
      Effect.map(readStoredStateOrDie(states.get(plugin.id), plugin.id), (state): PluginDetail => ({
        ...plugin,
        ...state,
        contributions: (contributions.get(plugin.id) ?? []).map(
          ({ extensionPoint, id, definition }) => ({ extensionPoint, id, definition }),
        ),
      })),
    );
  });

  /** One plugin, without the grant check: a move has already been checked once. */
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
   * A refused plugin has no code running and no catalog rows, so there is
   * nothing for any move to act on.
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
   * For a move that ends in a start. A plugin whose `register` or teardown
   * failed cannot start again in this process; only a restart clears either.
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
   * The write set and its audit entry in one transaction, so the log never
   * claims what the database rolled back. Naming the plugin as a record is what
   * tells a live subscriber to refetch it.
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
     * JSON Schema. Fails with `Forbidden` if the caller lacks the grant.
     */
    queryWorkflowActions: (): Effect.Effect<ReadonlyArray<WorkflowAction>, Forbidden> =>
      Effect.gen(function* () {
        yield* requireGrant("workflowAction.query");
        const actions = yield* host.listActiveWorkflowActions();
        return actions.map(({ id, displayName, description, inputSchema }) => ({
          id,
          displayName,
          description,
          inputSchema,
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
            const detail = yield* readMovablePluginOrFail(id);
            if (!detail.enabled) return detail;
            yield* host.stop(id);
            yield* writeMove(id, "plugin.disabled", (at) => repository.setEnabled(id, false, at));
            return yield* readPluginOrFail(id);
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
     * Throws away everything a plugin stored and starts it over. Allowed while
     * inactive or errored too: leftover state is a plausible cause of both.
     */
    resetState: (id: string): Effect.Effect<PluginDetail, MoveError> =>
      Effect.gen(function* () {
        yield* requireGrant("plugin.resetState");
        return yield* host.serialized(
          Effect.gen(function* () {
            yield* readRestartablePluginOrFail(id);
            const stopped = yield* host.stop(id);
            yield* writeMove(id, "plugin.stateReset", () => repository.kvWipe(id));
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
