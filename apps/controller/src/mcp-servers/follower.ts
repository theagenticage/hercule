/**
 * The Connection follower (spec 21 section 1.3): it keeps a plugin server's
 * status in step with its Connection and its plugin.
 *
 * It listens to committed changes of `connection` and `plugin` records, and
 * for each server they touch it reads the Connection and the plugin fresh and
 * writes only when what it finds differs from what the server holds
 * (`followDependencies`). So a change that is repeated, merged with another or
 * missed while the controller was down does no harm: the follower follows
 * every server once when it starts.
 *
 * A status the server earned itself (no cause) is never touched here, except
 * that a reconnect asks for a new check.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { absorbFailures } from "../absorbing";
import { RecordChanges } from "../db";
import { McpServerChecks } from "./checks";
import { mcpServerRepository, type McpServerDependencyIds } from "./repository";
import { mcpServerState, parsePluginId } from "./state";

/**
 * How a read or a write of the database that failed is tried again: twice
 * more, three seconds apart, and then it is logged and left to the next
 * change or the daily check.
 */
const RETRY_AFTER_SQL_FAILURE = { schedule: Schedule.spaced(Duration.seconds(3)), times: 2 };

/**
 * Follows the Connections and plugins of the MCP Servers, for the life of the
 * fiber that runs it. It subscribes first, then follows every server once,
 * then follows the servers of each Connection and plugin that changes. Never
 * returns. A server whose follow fails is logged and never stops the
 * others or the follower. A batch whose server list could not be read is left
 * to the daily check of each server.
 */
export const runConnectionFollower = Effect.scoped(
  Effect.gen(function* () {
    const changes = yield* RecordChanges;
    const checks = yield* McpServerChecks;
    const servers = yield* mcpServerRepository;
    const state = yield* mcpServerState;

    /** Follows one server, and wakes the checks when it needs a new check. */
    const followServer = (id: string) =>
      absorbFailures(
        `Following the Connection of MCP server ${id} failed`,
        state.followDependencies(id).pipe(
          Effect.retry(RETRY_AFTER_SQL_FAILURE),
          Effect.flatMap((needsCheck) => (needsCheck ? checks.wake : Effect.void)),
        ),
      );

    /** Follows the servers `selected` picks. */
    const followSelected = (selected: (server: McpServerDependencyIds) => boolean) =>
      absorbFailures(
        "The MCP servers could not be read to follow their Connections: their next daily check brings them in step",
        servers.listDependencyIds().pipe(
          Effect.retry(RETRY_AFTER_SQL_FAILURE),
          Effect.flatMap((all) =>
            Effect.forEach(all.filter(selected), ({ id }) => followServer(id), {
              concurrency: "unbounded",
              discard: true,
            }),
          ),
        ),
      );

    // Subscribe before the first read of the servers, so no change in between is lost.
    const subscription = yield* changes.subscribe(["connection", "plugin"]);
    yield* followSelected(() => true);
    while (true) {
      const connectionIds = new Set<string>();
      const pluginIds = new Set<string>();
      for (const change of yield* subscription.takePending) {
        (change.topic === "connection" ? connectionIds : pluginIds).add(change.id);
      }
      yield* followSelected(
        (server) =>
          connectionIds.has(server.connectionId) ||
          pluginIds.has(parsePluginId(server.contributionId)),
      );
    }
  }),
);
