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
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import { absorbFailures } from "../absorbing";
import { connectionRepository } from "../connections";
import { nowIso, RecordChanges } from "../db";
import { PluginHost } from "../plugins";
import { PromotionState } from "../promotion";
import { Notifier } from "../notifications";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { McpServerChecks } from "./checks";
import { mcpServerRepository, type McpServerEdit, type StoredMcpServer } from "./repository";
import { readBasis, writeServerState } from "./state";

/** How many times a reconcile reads the server again after losing a race with another write. */
const MAX_ATTEMPTS = 3;

/** Returns the id of the plugin that offers a contribution: `sentry/sentry` is offered by `sentry`. */
const readPluginId = (contributionId: string): string =>
  contributionId.slice(0, contributionId.indexOf("/"));

/**
 * Follows the Connections and plugins of the MCP Servers, for the life of the
 * fiber that runs it. It subscribes first, then reconciles every server once,
 * then reconciles the servers of each Connection and plugin that changes.
 * Never returns, and a failure in one reconcile is logged and does not stop it.
 */
export const runConnectionFollower = Effect.scoped(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const changes = yield* RecordChanges;
    const checks = yield* McpServerChecks;
    const plugins = yield* PluginHost;
    const promotion = yield* PromotionState;
    const notifier = yield* Notifier;
    const servers = yield* mcpServerRepository;
    const connections = yield* connectionRepository;

    /**
     * Brings one server in step with its Connection and plugin, when it
     * differs. Does nothing for a server that is gone or switched off.
     */
    const reconcile = (id: string, attempt: number): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const found = yield* servers.readById(id);
        if (Option.isNone(found) || !found.value.enabled) return;
        const server = found.value;
        const connection = yield* connections.one(server.connectionId);
        if (Option.isNone(connection)) return;

        const pluginId = readPluginId(server.contributionId);
        const pluginIsActive =
          Option.isSome(yield* plugins.findMcpServer(server.contributionId)) &&
          (yield* plugins.isActive(pluginId));
        const label = connection.value.label;

        // What the server should show now, when its plugin or Connection is not usable.
        const unusable = pluginIsActive
          ? connection.value.status === "disabled"
            ? ({
                status: "error",
                detail: `The Connection ${label} is switched off`,
                cause: "connection",
              } as const)
            : connection.value.status === "needs-reauth"
              ? ({
                  status: "needs-sign-in",
                  detail: `Reconnect ${label} in Settings > Connections`,
                  cause: "connection",
                } as const)
              : undefined
          : ({
              status: "error",
              detail: `The ${
                (yield* plugins.loaded()).find((plugin) => plugin.id === pluginId)?.displayName ??
                pluginId
              } plugin is switched off`,
              cause: "plugin",
            } as const);

        let edit: McpServerEdit | undefined;
        let requestCheck = false;
        if (unusable !== undefined) {
          const differs =
            server.status !== unusable.status ||
            server.statusDetail !== unusable.detail ||
            server.statusCause !== unusable.cause;
          if (differs) {
            // The revision moves so that a check that started before cannot
            // write its older result over this one.
            edit = {
              status: unusable.status,
              statusDetail: unusable.detail,
              statusCause: unusable.cause,
              bumpRevision: true,
            };
          }
        } else {
          const reconnected =
            connection.value.credentialsReplacedAt !== server.connectionGeneration;
          if (reconnected || server.statusCause !== null) {
            edit = {
              bumpRevision: true,
              ...(reconnected
                ? { connectionGeneration: connection.value.credentialsReplacedAt }
                : {}),
              // The old status was caused by the plugin or the Connection,
              // which is fine now, so it no longer holds.
              ...(server.statusCause === null
                ? {}
                : { status: "checking", statusDetail: null, statusCause: null }),
            };
            requestCheck = true;
          }
        }
        if (edit === undefined) return;

        const at = yield* nowIso;
        const written = yield* promotion.whenServing(
          writeServerState(id, readBasis(server), edit, at).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.provideService(Notifier, notifier),
          ),
        );
        if (!written) {
          // Something else changed the server since it was read: look again.
          if (attempt < MAX_ATTEMPTS) yield* reconcile(id, attempt + 1);
          return;
        }
        if (requestCheck) yield* checks.request(id);
      });

    const reconcileAll = (selected: (server: StoredMcpServer) => boolean) =>
      Effect.flatMap(servers.list(), (all) =>
        Effect.forEach(
          all.filter(selected),
          (server) =>
            absorbFailures(
              `Following the Connection of MCP server ${server.id} failed`,
              reconcile(server.id, 1),
            ),
          { discard: true },
        ),
      );

    // Subscribe before the first read of the servers, so no change in between is lost.
    const subscription = yield* changes.subscribe;
    yield* absorbFailures(
      "Reading the MCP servers to follow their Connections failed",
      reconcileAll(() => true),
    );
    while (true) {
      const batch = yield* PubSub.takeAll(subscription);
      const connectionIds = new Set<string>();
      const pluginIds = new Set<string>();
      for (const change of batch) {
        if (change.topic === "connection") connectionIds.add(change.id);
        if (change.topic === "plugin") pluginIds.add(change.id);
      }
      if (connectionIds.size === 0 && pluginIds.size === 0) continue;
      yield* absorbFailures(
        "Reading the MCP servers to follow their Connections failed",
        reconcileAll(
          (server) =>
            connectionIds.has(server.connectionId) ||
            pluginIds.has(readPluginId(server.contributionId)),
        ),
      );
    }
  }),
);
