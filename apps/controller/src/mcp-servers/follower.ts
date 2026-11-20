/**
 * The Connection follower (spec 21 section 1.3): it keeps a plugin server's
 * status in step with its Connection and its plugin.
 *
 * It listens to committed changes of `connection` and `plugin` records,
 * reads the Connection and the plugin fresh, and writes only when what it
 * finds differs from what the server holds. So a change that is repeated,
 * merged with another or missed while the controller was down does no harm:
 * the follower reconciles every server once when it starts.
 *
 * A status the server earned itself (no cause) is never touched here, except
 * that a reconnect asks for a new check.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { absorbFailures } from "../absorbing";
import { nowIso, RecordChanges } from "../db";
import { Notifier } from "../notifications";
import { PluginHost } from "../plugins";
import { PromotionState } from "../promotion";
import { McpServerChecks } from "./checks";
import { mcpServerRepository, type McpServerDependencyIds, type McpServerEdit } from "./repository";
import { judgeDependencies, parsePluginId, readDependencies, writeServerState } from "./state";

/** How many times a reconcile reads the server again after losing a race with another write. */
const MAX_RACE_ATTEMPTS = 3;

/**
 * How many times in all the follower reads the server list, or reconciles a
 * server whose reconcile failed, before it gives up until the next change.
 */
const MAX_FAILURE_ATTEMPTS = 3;

/** How long the follower waits before it reads the server list or reconciles a server again after a failure. */
const RETRY_DELAY = Duration.seconds(3);

/**
 * Follows the Connections and plugins of the MCP Servers, for the life of the
 * fiber that runs it. It subscribes first, then reconciles every server once,
 * then reconciles the servers of each Connection and plugin that changes.
 * Never returns. A reconcile or a read of the server list that fails is
 * logged and tried again after a few seconds, up to three times in all, and
 * never stops the follower. A batch whose server list could not be read is
 * left to the daily check of each server.
 */
export const runConnectionFollower = Effect.scoped(
  Effect.gen(function* () {
    const changes = yield* RecordChanges;
    const checks = yield* McpServerChecks;
    const promotion = yield* PromotionState;
    const servers = yield* mcpServerRepository;

    /**
     * Brings one server in step with its Connection and plugin, when it
     * differs. Does nothing for a server that is gone or switched off.
     */
    const reconcile = (
      id: string,
      attempt: number,
    ): Effect.Effect<void, SqlError, SqlClient.SqlClient | PluginHost | Notifier> =>
      Effect.gen(function* () {
        const found = yield* servers.readById(id);
        if (Option.isNone(found) || !found.value.enabled) return;
        const server = found.value;
        const dependencies = yield* readDependencies(server);
        const judged = judgeDependencies(dependencies);
        const at = yield* nowIso;

        let edit: McpServerEdit | undefined;
        let requestCheck = false;
        if (judged._tag === "unusable") {
          const differs =
            server.status !== judged.status ||
            server.statusDetail !== judged.detail ||
            server.statusCause !== judged.cause;
          if (differs) {
            // The revision moves so that a check that started before cannot
            // write its older result over this one.
            edit = {
              status: judged.status,
              statusDetail: judged.detail,
              statusCause: judged.cause,
              bumpRevision: true,
            };
          }
        } else {
          const reconnected =
            judged.connection.credentialsGeneration !== server.connectionGeneration;
          if (reconnected || server.statusCause !== null) {
            // The check is marked due in the same write, so it still happens
            // when the request for it below is lost to a stop. A new
            // generation or a recovered cause also ends any backoff.
            edit = {
              bumpRevision: true,
              failedChecks: 0,
              nextCheckAt: at,
              ...(reconnected
                ? { connectionGeneration: judged.connection.credentialsGeneration }
                : {}),
              // The old status was caused by the plugin or the Connection,
              // which is fine now, so the cause is cleared. The status and
              // its detail stay until the check that was just requested
              // writes its result: a later check never goes back to
              // `checking` (spec 21 section 5.3).
              ...(server.statusCause === null ? {} : { statusCause: null }),
            };
            requestCheck = true;
          }
        }
        if (edit === undefined) return;

        const written = yield* promotion.whenServing(
          writeServerState(id, { revision: server.revision, dependencies }, edit, at),
        );
        if (!written) {
          // Something else changed the server, its Connection or its plugin
          // since they were read: look again.
          if (attempt < MAX_RACE_ATTEMPTS) yield* reconcile(id, attempt + 1);
          return;
        }
        if (requestCheck) yield* checks.request(id);
      });

    /**
     * Reads the ids of the servers `selected` picks. A failed read is logged
     * and tried again after `RETRY_DELAY`, up to `MAX_FAILURE_ATTEMPTS` times
     * in all. Returns `undefined` when every try failed, after logging that
     * the daily check of each server is what brings it in step then.
     */
    const readSelectedIds = (selected: (server: McpServerDependencyIds) => boolean) =>
      Effect.gen(function* () {
        for (let attempt = 1; attempt <= MAX_FAILURE_ATTEMPTS; attempt++) {
          let ids: ReadonlyArray<string> | undefined;
          yield* absorbFailures(
            "Reading the MCP servers to follow their Connections failed",
            Effect.flatMap(servers.listDependencyIds(), (all) =>
              Effect.sync(() => {
                ids = all.filter(selected).map((server) => server.id);
              }),
            ),
          );
          if (ids !== undefined) return ids;
          if (attempt < MAX_FAILURE_ATTEMPTS) yield* Effect.sleep(RETRY_DELAY);
        }
        yield* Effect.logError(
          "The MCP servers could not be read to follow their Connections: their next daily check brings them in step",
        );
        return undefined;
      });

    /**
     * Reconciles the servers `selected` picks. A server whose reconcile fails
     * is logged, and reconciled again after `RETRY_DELAY`, up to
     * `MAX_FAILURE_ATTEMPTS` times in all.
     */
    const reconcileSelected = (selected: (server: McpServerDependencyIds) => boolean) =>
      Effect.gen(function* () {
        let pending = (yield* readSelectedIds(selected)) ?? [];
        for (let attempt = 1; pending.length > 0; attempt++) {
          const failing: Array<string> = [];
          for (const id of pending) {
            yield* absorbFailures(
              `Following the Connection of MCP server ${id} failed`,
              reconcile(id, 1).pipe(Effect.tapCause(() => Effect.sync(() => failing.push(id)))),
            );
          }
          if (attempt === MAX_FAILURE_ATTEMPTS) return;
          pending = failing;
          if (pending.length > 0) yield* Effect.sleep(RETRY_DELAY);
        }
      });

    // Subscribe before the first read of the servers, so no change in between is lost.
    const subscription = yield* changes.subscribe(["connection", "plugin"]);
    yield* reconcileSelected(() => true);
    while (true) {
      const connectionIds = new Set<string>();
      const pluginIds = new Set<string>();
      for (const change of yield* subscription.takePending) {
        (change.topic === "connection" ? connectionIds : pluginIds).add(change.id);
      }
      yield* reconcileSelected(
        (server) =>
          connectionIds.has(server.connectionId) ||
          pluginIds.has(parsePluginId(server.contributionId)),
      );
    }
  }),
);
