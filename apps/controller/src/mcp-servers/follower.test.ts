/**
 * Tests what the Connection follower does when it starts, on a database that
 * changed while no follower was running: it reconciles every server once,
 * without waiting for a change to be announced. The follower runs with the
 * real checks and a fake outside MCP server, so what a server's cause being
 * gone or its Connection being reconnected leads to is observed at the
 * server's row and at the requests the outside server receives:
 *
 * - a Connection that needs sign-in, a plugin that is not in the build, or a
 *   plugin that failed to start, moves the server to the status that cause
 *   gives it, and nothing is sent;
 * - a server whose cause is gone, or whose Connection was reconnected, ends
 *   its backoff and is listed again at once, with the Connection's new
 *   generation;
 * - a recovered server keeps its old status until the new list is back: it
 *   never goes back to `checking`;
 * - a read of the server list that fails at that moment is tried again, so
 *   the servers are still followed. The only way to fail that read, at a
 *   boundary no code of the follower is faked, is to break the database
 *   itself, so the test renames the table away for a moment.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Layer, Redacted } from "effect";
import { PluginError } from "@hercule/plugin-host";
import * as SqlClient from "effect/sql/SqlClient";
import { connectionRepository } from "../connections";
import { nowIso, RecordChangesLayer, withTransaction } from "../db";
import { PluginHost } from "../plugins";
import {
  asUser,
  buildDeskMcpServer,
  buildMcpServerPlugin,
  buildPluginStack,
} from "../plugins/testing";
import { Secrets } from "../secrets";
import { McpServerChecks, McpServerChecksLayer } from "./checks";
import { runConnectionFollower } from "./follower";
import { mcpServerRepository, type StoredMcpServer } from "./repository";
import { startFakeUpstream, type FakeUpstream } from "./testing";

interface Arrangement {
  /** Boots the `acme` plugin that offers the server. A server with its plugin missing sets this to false. */
  readonly pluginBuilt: boolean;
  /** Makes the plugin fail when it starts, so it is enabled but not running. */
  readonly pluginFailsToStart?: true;
  readonly connectionStatus: "connected" | "needs-reauth";
  /** Makes the server list unreadable for the follower's first read, as a database that fails for a moment would. */
  readonly listUnreadableAtStart?: true;
  /** Makes the outside server hold every answer until the test has looked at the row. */
  readonly holdUpstream?: true;
  /** Written to the Connection, as many reconnects as it takes to differ from the server's. */
  readonly credentialsGeneration: number;
  /** What the server holds before the follower starts. */
  readonly server: {
    readonly status: "ready" | "error";
    readonly statusCause: string | null;
    readonly failedChecks: number;
  };
}

/**
 * Arranges a database and an outside server, starts the follower on it, waits
 * until `settled` accepts the server and the requests the outside server has
 * received, and returns both.
 */
const followUntil = (
  arrangement: Arrangement,
  settled: (server: StoredMcpServer, upstream: FakeUpstream) => boolean,
): Promise<{ readonly server: StoredMcpServer; readonly upstream: FakeUpstream }> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const upstream = yield* Effect.acquireRelease(
          Effect.promise(() => startFakeUpstream()),
          (started) => Effect.promise(() => started.stop()),
        );
        const releaseUpstream = arrangement.holdUpstream === true ? upstream.hold() : () => {};
        yield* Effect.addFinalizer(() => Effect.sync(releaseUpstream));
        const sql = yield* SqlClient.SqlClient;
        const host = yield* PluginHost;
        const connections = yield* connectionRepository;
        const secrets = yield* Secrets;
        const servers = yield* mcpServerRepository;
        if (arrangement.pluginBuilt) {
          const plugin = buildMcpServerPlugin("acme", {
            server: buildDeskMcpServer("acme", upstream),
          });
          yield* host.boot([
            arrangement.pluginFailsToStart === true
              ? { ...plugin, activate: () => Effect.fail(new PluginError({ message: "no" })) }
              : plugin,
          ]);
        }

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
            yield* secrets.set(
              { kind: "connection", id: connection.id },
              "token",
              Redacted.make("t0ken"),
            );
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
              SET status = ${arrangement.server.status},
                  status_detail = 'what the server showed before',
                  status_cause = ${arrangement.server.statusCause},
                  failed_checks = ${arrangement.server.failedChecks},
                  next_check_at = '2099-01-01T00:00:00.000Z'
            `;
            return server.id;
          }),
        );

        if (arrangement.listUnreadableAtStart === true) {
          yield* withTransaction(sql, sql`ALTER TABLE mcp_servers RENAME TO mcp_servers_away`);
        }
        yield* Effect.forkScoped(runConnectionFollower);
        const checks = yield* McpServerChecks;
        yield* Effect.forkScoped(checks.run(Duration.minutes(1)));
        if (arrangement.listUnreadableAtStart === true) {
          // The follower reads the list at once, and fails.
          yield* Effect.sleep("100 millis");
          yield* withTransaction(sql, sql`ALTER TABLE mcp_servers_away RENAME TO mcp_servers`);
        }

        for (let attempt = 0; attempt < 500; attempt++) {
          const server = (yield* servers.readById(serverId)).pipe((found) =>
            found._tag === "Some" ? found.value : undefined,
          );
          if (server !== undefined && settled(server, upstream)) return { server, upstream };
          yield* Effect.sleep("10 millis");
        }
        return yield* Effect.die(new Error("the follower did not reach the expected state"));
      }),
    ).pipe(
      Effect.provide(
        Layer.provideMerge(
          McpServerChecksLayer,
          Layer.mergeAll(buildPluginStack(), RecordChangesLayer),
        ),
      ),
      asUser,
    ),
  );

describe("the Connection follower at startup", () => {
  it("moves a server to needs-sign-in when its Connection needs sign-in, and sends nothing", async () => {
    const { server, upstream } = await followUntil(
      {
        pluginBuilt: true,
        connectionStatus: "needs-reauth",
        credentialsGeneration: 0,
        server: { status: "ready", statusCause: null, failedChecks: 0 },
      },
      (found) => found.status === "needs-sign-in",
    );

    expect(server).toMatchObject({
      statusDetail: "Reconnect work in Settings > Connections",
      statusCause: "connection",
    });
    expect(upstream.requests).toEqual([]);
  });

  it("moves a server to error when its plugin is not in the build", async () => {
    const { server } = await followUntil(
      {
        pluginBuilt: false,
        connectionStatus: "connected",
        credentialsGeneration: 0,
        server: { status: "ready", statusCause: null, failedChecks: 0 },
      },
      (found) => found.status === "error",
    );

    expect(server).toMatchObject({
      statusDetail: "The plugin that offered this server is not in this build",
      statusCause: "plugin",
    });
  });

  it("moves a server to error, in words that differ from a switched-off plugin's, when its plugin failed to start", async () => {
    const { server, upstream } = await followUntil(
      {
        pluginBuilt: true,
        pluginFailsToStart: true,
        connectionStatus: "connected",
        credentialsGeneration: 0,
        server: { status: "ready", statusCause: null, failedChecks: 0 },
      },
      (found) => found.status === "error",
    );

    expect(server).toMatchObject({
      statusDetail: "The Acme plugin failed to start: see Settings > Plugins",
      statusCause: "plugin",
    });
    expect(upstream.requests).toEqual([]);
  });

  it("reads the server list again when the first read fails, and then follows the Connection", async () => {
    const { server } = await followUntil(
      {
        pluginBuilt: true,
        connectionStatus: "needs-reauth",
        credentialsGeneration: 0,
        listUnreadableAtStart: true,
        server: { status: "ready", statusCause: null, failedChecks: 0 },
      },
      (found) => found.status === "needs-sign-in",
    );

    expect(server.statusCause).toBe("connection");
  });

  it.each([
    ["a cause that is gone", { status: "error", statusCause: "connection", failedChecks: 4 }, 0],
    [
      "a reconnect that happened while it was down",
      { status: "ready", statusCause: null, failedChecks: 4 },
      3,
    ],
  ] as const)(
    "lists a server again at once, with its backoff ended, for %s",
    async (_name, held, credentialsGeneration) => {
      const { server, upstream } = await followUntil(
        { pluginBuilt: true, connectionStatus: "connected", credentialsGeneration, server: held },
        (found) => found.status === "ready" && found.checkedAt !== null,
      );

      expect(server).toMatchObject({
        status: "ready",
        statusCause: null,
        failedChecks: 0,
        connectionGeneration: credentialsGeneration,
      });
      expect(upstream.requests.map((request) => request.authorization)).toContain("Bearer t0ken");
    },
  );

  it("keeps a recovered server's old status, and never shows it as checking, until the new list is back", async () => {
    const { server } = await followUntil(
      {
        pluginBuilt: true,
        connectionStatus: "connected",
        credentialsGeneration: 0,
        holdUpstream: true,
        server: { status: "error", statusCause: "connection", failedChecks: 0 },
      },
      // The cause is cleared in the same write that marks the check due, and
      // the check is then waiting on the held outside server.
      (found, held) => found.statusCause === null && held.requests.length > 0,
    );

    expect(server).toMatchObject({
      status: "error",
      statusDetail: "what the server showed before",
    });
  });
});
