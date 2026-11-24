/**
 * Tests the controller daemon's `ConnectionObserver` over HTTP, against a real
 * controller with two test plugins that each offer an MCP server and a
 * Connection type (`acme/desk` and `bolt/desk`). Only Acme's server sets
 * `addWhenConnected`:
 *
 * - creating an Acme Connection adds exactly one server for it, enabled and
 *   attached to no list, stamped with the user who created the Connection;
 * - a Bolt Connection, whose server does not set the flag, adds none;
 * - a reconnect adds none, also after the user deleted the server;
 * - a second Connection of another account gets a server of the same name,
 *   and one of the same account gets no second server;
 * - a session without `mcp.manage` creates the Connection and gets no server,
 *   and a session with it gets the server, stamped with the session;
 * - the same holds when the session starts a redirect sign-in and the browser
 *   finishes it at the controller's callback, which carries no credential.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpServer } from "@hercule/contract";
import {
  HOST_API,
  registerConnectionType,
  registerMcpServer,
  type Plugin,
} from "@hercule/plugin-host";
import { Effect, Schema } from "effect";
import { buildAccount, buildJsonResponse } from "../../connections/testing";
import { del, get, post } from "../../http/testing";
import { buildDeskMcpServer, buildMcpServerPlugin } from "../../plugins/testing";
import { WAIT_DEADLINE_MS, createProfile, spawnThreadUnder } from "../../sessions/testing";
import { withFleet } from "../../workspaces/testing";
import { withSetUpController, type SetUpController } from "../../workflows/testing";
import { startFakeUpstream, type FakeUpstream } from "../../mcp-servers/testing";

let upstream: FakeUpstream;
let PLUGINS: ReadonlyArray<Plugin>;

beforeAll(async () => {
  upstream = await startFakeUpstream();
  // A created server stays in status `checking`, and no test reaches the network.
  upstream.hold();
  PLUGINS = [
    buildMcpServerPlugin("acme", {
      server: { ...buildDeskMcpServer("acme", upstream), addWhenConnected: true },
      accountIsToken: true,
    }),
    buildMcpServerPlugin("bolt", { server: buildDeskMcpServer("bolt", upstream) }),
  ];
});

afterAll(async () => {
  await upstream.stop();
});

/** Creates a Connection with `token` as the caller, and returns the response. */
const requestConnection = (
  base: string,
  token: string,
  type: string,
  pastedToken: string,
): Promise<Response> =>
  post(
    base,
    "/api/v1/connections",
    { type, label: pastedToken, credentials: { token: pastedToken } },
    token,
  );

const createConnectionOrFail = async (
  base: string,
  token: string,
  type: string,
  pastedToken: string,
): Promise<string> => {
  const response = await requestConnection(base, token, type, pastedToken);
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
};

const listServers = async (controller: SetUpController): Promise<ReadonlyArray<McpServer>> => {
  const response = await get(controller.base, "/api/v1/mcp-servers", controller.token);
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<McpServer> }).items;
};

describe("a Connection whose plugin's server sets addWhenConnected", () => {
  it("adds exactly one server for it, stamped with the user", async () => {
    await withSetUpController(async (controller) => {
      const connectionId = await createConnectionOrFail(
        controller.base,
        controller.token,
        "acme/desk",
        "one",
      );

      const servers = await listServers(controller);

      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({
        name: "desk",
        source: { kind: "plugin", contributionId: "acme/desk", connectionId },
        enabled: true,
        status: "checking",
      });
      const created = await controller.harness.audit("mcpServer.created");
      expect(created.map((entry) => entry.actor)).toEqual(["user"]);
    }, PLUGINS);
  });

  it("adds none for a Connection of a plugin whose server does not set it", async () => {
    await withSetUpController(async (controller) => {
      await createConnectionOrFail(controller.base, controller.token, "bolt/desk", "one");

      expect(await listServers(controller)).toEqual([]);
    }, PLUGINS);
  });

  it("adds none when the Connection is reconnected, even after the user deleted the server", async () => {
    await withSetUpController(async (controller) => {
      const connectionId = await createConnectionOrFail(
        controller.base,
        controller.token,
        "acme/desk",
        "one",
      );
      const [server] = await listServers(controller);
      const deleted = await del(
        controller.base,
        `/api/v1/mcp-servers/${server!.id}`,
        controller.token,
      );
      expect(deleted.status).toBe(200);

      const reconnected = await post(
        controller.base,
        `/api/v1/connections/${connectionId}/credentials`,
        { credentials: { token: "one" } },
        controller.token,
      );

      expect(reconnected.status, await reconnected.clone().text()).toBe(200);
      expect(await listServers(controller)).toEqual([]);
    }, PLUGINS);
  });

  it("gives a Connection of another account a server of the same name, and none for the same account", async () => {
    await withSetUpController(async (controller) => {
      const first = await createConnectionOrFail(
        controller.base,
        controller.token,
        "acme/desk",
        "one",
      );
      const second = await createConnectionOrFail(
        controller.base,
        controller.token,
        "acme/desk",
        "two",
      );
      // The same account as `first`: the server it has already is the one.
      const sameAccount = await requestConnection(
        controller.base,
        controller.token,
        "acme/desk",
        "one",
      );
      expect(sameAccount.status).toBe(201);

      const servers = await listServers(controller);

      expect(servers.map((server) => server.name)).toEqual(["desk", "desk"]);
      expect(
        servers
          .map((server) => (server.source.kind === "plugin" ? server.source.connectionId : ""))
          .toSorted(),
      ).toEqual([first, second].toSorted());
    }, PLUGINS);
  });
});

describe("a Connection a session creates", () => {
  it(
    "gets a server only when the session may manage MCP servers, stamped with the session",
    async () => {
      await withFleet(
        async (arranged) => {
          const controller = {
            harness: arranged.harness,
            base: arranged.harness.base,
            token: arranged.token,
          };
          const withoutManage = await spawnThreadUnder(
            arranged,
            await createProfile(arranged, "connector", ["connection.manage"]),
          );
          const withManage = await spawnThreadUnder(
            arranged,
            await createProfile(arranged, "connector-and-mcp", ["connection.manage", "mcp.manage"]),
          );

          await createConnectionOrFail(controller.base, withoutManage.token, "acme/desk", "one");
          expect(await listServers(controller)).toEqual([]);

          await createConnectionOrFail(controller.base, withManage.token, "acme/desk", "two");
          expect(await listServers(controller)).toHaveLength(1);
          const created = await controller.harness.audit("mcpServer.created");
          expect(created.map((entry) => entry.actor)).toEqual([`session:${withManage.session.id}`]);
        },
        { plugins: PLUGINS },
      );
    },
    WAIT_DEADLINE_MS * 3 + 10_000,
  );
});

/**
 * A plugin whose Connection type signs in through a redirect flow, as a
 * public client that ships its own client id, and whose MCP server sets
 * `addWhenConnected`. Its token endpoint is `tokenEndpoint`.
 */
const buildRedirectPlugin = (tokenEndpoint: string): Plugin => ({
  manifest: {
    id: "ridge",
    displayName: "Ridge",
    hostApi: HOST_API,
    capabilities: ["connections", "mcp-servers"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    Effect.gen(function* () {
      yield* registerConnectionType(host, {
        type: "desk",
        displayName: "Desk",
        setup: [{ kind: "oauth" }],
        oauth: {
          authorizationUrl: `${tokenEndpoint}/authorize`,
          tokenUrl: `${tokenEndpoint}/token`,
          scopes: [],
          publicClient: { clientId: "ridge-client", redirectUris: [RIDGE_REDIRECT_URI] },
        },
        validate: ({ accessToken }) => Effect.succeed(buildAccount(accessToken ?? "")),
      });
      yield* registerMcpServer(host, {
        ...buildDeskMcpServer("ridge", upstream),
        addWhenConnected: true,
      });
    }),
  activate: () => Effect.succeed(Effect.void),
});

/** The loopback address a public client may register as its redirect. */
const RIDGE_ORIGIN = "http://127.0.0.1:4937";
const RIDGE_REDIRECT_URI = `${RIDGE_ORIGIN}/oauth/callback`;

describe("a Connection a redirect sign-in creates at the controller's callback", () => {
  it(
    "adds the server as the session that started the sign-in, and none when that session may not manage MCP servers",
    async () => {
      const provider = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () =>
          buildJsonResponse({ access_token: "good-token", token_type: "bearer", expires_in: 3600 }),
      });
      try {
        await withFleet(
          async (arranged) => {
            const { base, token } = { base: arranged.harness.base, token: arranged.token };
            const controller = { harness: arranged.harness, base, token };
            const withoutManage = await spawnThreadUnder(
              arranged,
              await createProfile(arranged, "connector", ["connection.manage"]),
            );
            const withManage = await spawnThreadUnder(
              arranged,
              await createProfile(arranged, "connector-and-mcp", [
                "connection.manage",
                "mcp.manage",
              ]),
            );
            const signIn = async (sessionToken: string): Promise<void> => {
              const started = await post(
                base,
                "/api/v1/oauth/start",
                { type: "ridge/desk", origin: RIDGE_ORIGIN },
                sessionToken,
              );
              expect(started.status, await started.clone().text()).toBe(200);
              const { authorizationUrl } = (await started.json()) as { authorizationUrl: string };
              const state = new URL(authorizationUrl).searchParams.get("state") ?? "";
              // The browser comes back with no credential at all.
              const callback = await fetch(`${base}/oauth/callback?state=${state}&code=the-code`, {
                redirect: "manual",
              });
              expect(callback.headers.get("location")).toBe("/connections?oauth=ok");
            };

            await signIn(withoutManage.token);
            expect(await listServers(controller)).toEqual([]);

            await signIn(withManage.token);
            expect(await listServers(controller)).toHaveLength(1);
            const created = await controller.harness.audit("mcpServer.created");
            expect(created.map((entry) => entry.actor)).toEqual([
              `session:${withManage.session.id}`,
            ]);
          },
          { plugins: [buildRedirectPlugin(`http://127.0.0.1:${String(provider.port)}`)] },
        );
      } finally {
        await provider.stop(true);
      }
    },
    WAIT_DEADLINE_MS * 3 + 10_000,
  );
});
