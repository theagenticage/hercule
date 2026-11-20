/**
 * Tests what the Connection follower does when it starts, on a database that
 * changed while no follower was running: it reconciles every server once,
 * without waiting for a change to be announced.
 *
 * - a Connection that needs sign-in, or a plugin that is not in the build,
 *   moves the server to the status that cause gives it;
 * - a server whose cause is gone, or whose Connection was reconnected, goes
 *   back to `checking`, ends its backoff, is marked due for a check at once,
 *   and asks for that check;
 * - a read of the server list that fails at that moment is tried again, so
 *   the servers are still followed.
 *
 * The checks are replaced by a recorder, because only the follower is tested.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { connectionRepository } from "../connections";
import { nowIso, RecordChangesLayer, withTransaction } from "../db";
import { PluginHost } from "../plugins";
import { asUser, buildMcpServerPlugin, buildPluginStack } from "../plugins/testing";
import { McpServerChecks } from "./checks";
import { runConnectionFollower } from "./follower";
import { mcpServerRepository, type StoredMcpServer } from "./repository";

interface Arrangement {
  /** Boots the `acme` plugin that offers the server. A server with its plugin missing sets this to false. */
  readonly pluginBuilt: boolean;
  readonly connectionStatus: "connected" | "needs-reauth";
  /** Makes the server list unreadable for the follower's first read, as a database that fails for a moment would. */
  readonly listUnreadableAtStart?: true;
  /** Written to the Connection, as many reconnects as it takes to differ from the server's. */
  readonly credentialsGeneration: number;
  /** What the server holds before the follower starts. */
  readonly server: {
    readonly statusCause: string | null;
    readonly failedChecks: number;
  };
}

/**
 * Arranges a database, starts the follower on it, waits until `settled`
 * accepts the server and the ids the follower asked checks for, and returns
 * both.
 */
const followUntil = (
  arrangement: Arrangement,
  settled: (server: StoredMcpServer, requested: ReadonlyArray<string>) => boolean,
): Promise<{ readonly server: StoredMcpServer; readonly requested: ReadonlyArray<string> }> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const host = yield* PluginHost;
        const connections = yield* connectionRepository;
        const servers = yield* mcpServerRepository;
        if (arrangement.pluginBuilt) yield* host.boot([buildMcpServerPlugin("acme")]);

        const at = yield* nowIso;
        const serverId = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const connection = yield* connections.insert({
              pluginId: "acme",
              type: "acme/desk",
              label: "work",
              displayName: "Desk",
              accountId: "desk-1",
              labels: [],
              config: {},
              at,
            });
            if (arrangement.connectionStatus === "needs-reauth") {
              yield* connections.changeStatusFrom(
                connection.id,
                ["connected"],
                "needs-reauth",
                null,
                at,
              );
            }
            yield* sql`UPDATE connections SET credentials_generation = ${arrangement.credentialsGeneration}`;
            const server = yield* servers.insert({
              name: "desk",
              contributionId: "acme/desk",
              connectionId: connection.id,
              accountId: "desk-1",
              connectionGeneration: 0,
              at,
            });
            yield* sql`
              UPDATE mcp_servers
              SET status = 'ready', status_cause = ${arrangement.server.statusCause},
                  failed_checks = ${arrangement.server.failedChecks},
                  next_check_at = '2099-01-01T00:00:00.000Z'
            `;
            return server.id;
          }),
        );

        const requested: Array<string> = [];
        const checks = Layer.succeed(McpServerChecks)({
          request: (id) => Effect.sync(() => void requested.push(id)),
          requestDue: Effect.void,
        });
        if (arrangement.listUnreadableAtStart === true) {
          yield* withTransaction(sql, sql`ALTER TABLE mcp_servers RENAME TO mcp_servers_away`);
        }
        yield* Effect.forkScoped(runConnectionFollower.pipe(Effect.provide(checks)));
        if (arrangement.listUnreadableAtStart === true) {
          // The follower reads the list at once, and fails.
          yield* Effect.sleep("100 millis");
          yield* withTransaction(sql, sql`ALTER TABLE mcp_servers_away RENAME TO mcp_servers`);
        }

        for (let attempt = 0; attempt < 500; attempt++) {
          const server = (yield* servers.readById(serverId)).pipe((found) =>
            found._tag === "Some" ? found.value : undefined,
          );
          if (server !== undefined && settled(server, requested)) return { server, requested };
          yield* Effect.sleep("10 millis");
        }
        return yield* Effect.die(new Error("the follower did not reach the expected state"));
      }),
    ).pipe(Effect.provide(Layer.mergeAll(buildPluginStack(), RecordChangesLayer)), asUser),
  );

describe("the Connection follower at startup", () => {
  it("moves a server to needs-sign-in when its Connection needs sign-in", async () => {
    const { server, requested } = await followUntil(
      {
        pluginBuilt: true,
        connectionStatus: "needs-reauth",
        credentialsGeneration: 0,
        server: { statusCause: null, failedChecks: 0 },
      },
      (found) => found.status === "needs-sign-in",
    );

    expect(server).toMatchObject({
      statusDetail: "Reconnect work in Settings > Connections",
      statusCause: "connection",
    });
    expect(requested).toEqual([]);
  });

  it("moves a server to error when its plugin is not in the build", async () => {
    const { server } = await followUntil(
      {
        pluginBuilt: false,
        connectionStatus: "connected",
        credentialsGeneration: 0,
        server: { statusCause: null, failedChecks: 0 },
      },
      (found) => found.status === "error",
    );

    expect(server).toMatchObject({
      statusDetail: "The plugin that offered this server is not in this build",
      statusCause: "plugin",
    });
  });

  it("reads the server list again when the first read fails, and then follows the Connection", async () => {
    const { server } = await followUntil(
      {
        pluginBuilt: true,
        connectionStatus: "needs-reauth",
        credentialsGeneration: 0,
        listUnreadableAtStart: true,
        server: { statusCause: null, failedChecks: 0 },
      },
      (found) => found.status === "needs-sign-in",
    );

    expect(server.statusCause).toBe("connection");
  });

  it.each([
    ["a cause that is gone", { statusCause: "connection", failedChecks: 4 }, 0],
    ["a reconnect that happened while it was down", { statusCause: null, failedChecks: 4 }, 3],
  ])(
    "marks a server due for a check at once, with its backoff ended, for %s",
    async (_name, held, credentialsGeneration) => {
      const { server, requested } = await followUntil(
        {
          pluginBuilt: true,
          connectionStatus: "connected",
          credentialsGeneration,
          server: held,
        },
        (found, asked) => found.revision > 0 && asked.length > 0,
      );

      expect(server.failedChecks).toBe(0);
      expect(server.connectionGeneration).toBe(credentialsGeneration);
      expect(Date.parse(server.nextCheckAt!)).toBeLessThanOrEqual(Date.now());
      expect(server.status).toBe(held.statusCause === null ? "ready" : "checking");
      expect(requested).toEqual([server.id]);
    },
  );
});
