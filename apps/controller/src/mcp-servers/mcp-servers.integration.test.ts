/**
 * Tests the MCP Server operations over HTTP, against a real controller with
 * two test plugins that each offer one MCP server (`acme/desk` and
 * `bolt/desk`) and a Connection type to reach it with. The outside server
 * never answers, so no check ends:
 *
 * - a create takes the contribution's word as the name unless one is given,
 *   and answers in status `checking` with no tools;
 * - a create is refused for a contribution no plugin offers, a Connection that
 *   does not exist or is of another type, a name that breaks the rule, and a
 *   second server for the same contribution and account, which names the
 *   existing one;
 * - `query` sorts by name, and an update switches a server on and off: a
 *   switch raises the revision, switching on goes back to `checking`, and the
 *   same value writes nothing;
 * - a check on a switched-off server is refused;
 * - a delete removes the server;
 * - `mcp.read` reads and `mcp.manage` writes;
 * - `connection.delete` is refused while a server uses the Connection.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { McpServer } from "@hercule/contract";
import { withTransaction } from "../db";
import { del, get, post, readErrorBody, send, type ServerHarness } from "../http/testing";
import { WAIT_DEADLINE_MS, createProfile, spawnThreadUnder } from "../sessions/testing";
import { withFleet } from "../workspaces/testing";
import { createConnection, withSetUpController } from "../workflows/testing";
import type { Plugin } from "@hercule/plugin-host";
import { buildUpstreamDeskPlugin, startFakeUpstream, type FakeUpstream } from "./testing";

/**
 * The outside server holds every answer, so a created server stays in status
 * `checking` for as long as a test looks at it, and no test reaches the real
 * network.
 */
let upstream: FakeUpstream;
let PLUGINS: ReadonlyArray<Plugin>;

beforeAll(async () => {
  upstream = await startFakeUpstream();
  upstream.hold();
  PLUGINS = [
    buildUpstreamDeskPlugin(upstream, { id: "acme" }),
    buildUpstreamDeskPlugin(upstream, { id: "bolt" }),
  ];
});

afterAll(async () => {
  await upstream.stop();
});

/** A well-formed id that no MCP Server has. */
const UNKNOWN_ID = "0199e0e7-0000-7000-8000-00000000dead";

interface Controller {
  readonly harness: ServerHarness;
  readonly base: string;
  readonly token: string;
}

/** Creates a Connection of the `desk` type of plugin `pluginId` and returns its id. */
const createDeskConnection = (controller: Controller, pluginId: string): Promise<string> =>
  createConnection(controller.base, controller.token, `${pluginId}/desk`, { token: "t0ken" });

/** Sends `mcpServer.create` for the contribution `<pluginId>/desk` and returns the raw response. */
const requestCreate = (
  controller: Controller,
  source: Record<string, unknown>,
  token = controller.token,
) => post(controller.base, "/api/v1/mcp-servers", { source: { kind: "plugin", ...source } }, token);

/** Creates a server and returns it, failing the test when the create is refused. */
const createServer = async (
  controller: Controller,
  source: Record<string, unknown>,
): Promise<McpServer> => {
  const response = await requestCreate(controller, source);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as McpServer;
};

const requestUpdate = (controller: Controller, id: string, body: unknown) =>
  send("PATCH", controller.base, `/api/v1/mcp-servers/${id}`, { body, token: controller.token });

const requestCheck = (controller: Controller, id: string, token = controller.token) =>
  post(controller.base, `/api/v1/mcp-servers/${id}/check`, {}, token);

const readServer = async (controller: Controller, id: string): Promise<McpServer> => {
  const response = await get(controller.base, `/api/v1/mcp-servers/${id}`, controller.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as McpServer;
};

/** Runs a statement on the controller's database in its own transaction, for state no operation reaches. */
const runSql = <A>(controller: Controller, statement: Effect.Effect<A, unknown>) =>
  Effect.runPromise(Effect.orDie(withTransaction(controller.harness.sql, statement)));

/** Returns the revision of the only server there is. */
const readRevision = async (controller: Controller): Promise<number> => {
  const rows = await runSql(
    controller,
    controller.harness.sql<{ readonly revision: number }>`SELECT revision FROM mcp_servers`,
  );
  return rows[0]!.revision;
};

describe("mcpServer.create", () => {
  it("answers in status checking and names the server after the contribution", async () => {
    await withSetUpController(async (controller) => {
      const connectionId = await createDeskConnection(controller, "acme");

      const server = await createServer(controller, {
        contributionId: "acme/desk",
        connectionId,
      });

      expect(server).toMatchObject({
        name: "desk",
        source: { kind: "plugin", contributionId: "acme/desk", connectionId },
        enabled: true,
        status: "checking",
        statusDetail: null,
        tools: [],
        checkedAt: null,
      });
      expect(await readServer(controller, server.id)).toEqual(server);
      expect(await controller.harness.audit("mcpServer.created")).toHaveLength(1);
    }, PLUGINS);
  });

  it("refuses what cannot make a server, and names the existing server for a second one", async () => {
    await withSetUpController(async (controller) => {
      const acme = await createDeskConnection(controller, "acme");
      const bolt = await createDeskConnection(controller, "bolt");
      const refuse = async (source: Record<string, unknown>) => {
        const response = await requestCreate(controller, source);
        expect(response.status).toBe(400);
        return readErrorBody(response);
      };

      expect((await refuse({ contributionId: "acme/nothing", connectionId: acme })).issues).toEqual(
        [["source", "contributionId"]],
      );
      expect(
        (await refuse({ contributionId: "acme/desk", connectionId: UNKNOWN_ID })).issues,
      ).toEqual([["source", "connectionId"]]);
      const otherType = await refuse({ contributionId: "acme/desk", connectionId: bolt });
      expect(otherType.issues).toEqual([["source", "connectionId"]]);
      expect(otherType.message).toBeDefined();
      for (const name of ["Desk", "my-desk", "a__b", "hercule", "a".repeat(17), ""]) {
        expect(
          (await refuse({ contributionId: "acme/desk", connectionId: acme, name })).issues,
          name,
        ).toEqual([["source", "name"]]);
      }
      expect(await controller.harness.audit("mcpServer.created")).toEqual([]);

      const first = await createServer(controller, {
        contributionId: "acme/desk",
        connectionId: acme,
        name: "work_desk",
      });
      // A second Connection of the same account is still the same account.
      const sameAccount = await createDeskConnection(controller, "acme");
      const second = await requestCreate(controller, {
        contributionId: "acme/desk",
        connectionId: sameAccount,
      });
      const refusal = await readErrorBody(second);
      expect(second.status, refusal.text).toBe(409);
      expect(refusal.code).toBe("conflict");
      expect(refusal.message).toContain(`work_desk (${first.id})`);
    }, PLUGINS);
  });
});

describe("mcpServer.query and mcpServer.update", () => {
  it("lists the servers sorted by name", async () => {
    await withSetUpController(async (controller) => {
      const acme = await createDeskConnection(controller, "acme");
      const bolt = await createDeskConnection(controller, "bolt");
      await createServer(controller, {
        contributionId: "acme/desk",
        connectionId: acme,
        name: "zed",
      });
      await createServer(controller, { contributionId: "bolt/desk", connectionId: bolt });

      const response = await get(controller.base, "/api/v1/mcp-servers", controller.token);

      expect(response.status).toBe(200);
      const { items } = (await response.json()) as { items: ReadonlyArray<McpServer> };
      expect(items.map((server) => server.name)).toEqual(["desk", "zed"]);
    }, PLUGINS);
  });

  it("switches a server off and on, raises the revision, and goes back to checking", async () => {
    await withSetUpController(async (controller) => {
      const connectionId = await createDeskConnection(controller, "acme");
      const server = await createServer(controller, {
        contributionId: "acme/desk",
        connectionId,
      });
      await runSql(
        controller,
        controller.harness.sql`UPDATE mcp_servers SET status = 'ready', status_cause = 'x'`,
      );
      expect(await readRevision(controller)).toBe(0);

      const off = await requestUpdate(controller, server.id, { enabled: false });
      expect(off.status, await off.clone().text()).toBe(200);
      // The status stays: a client shows Off from `enabled`.
      expect(await off.json()).toMatchObject({ enabled: false, status: "ready" });
      expect(await readRevision(controller)).toBe(1);

      const same = await requestUpdate(controller, server.id, { enabled: false });
      expect(same.status).toBe(200);
      expect(await readRevision(controller)).toBe(1);

      const on = await requestUpdate(controller, server.id, { enabled: true });
      expect(await on.json()).toMatchObject({ enabled: true, status: "checking" });
      expect(await readRevision(controller)).toBe(2);
      expect(await controller.harness.audit("mcpServer.updated")).toHaveLength(2);
    }, PLUGINS);
  });

  it("refuses an update that gives nothing, and an unknown server", async () => {
    await withSetUpController(async (controller) => {
      const connectionId = await createDeskConnection(controller, "acme");
      const server = await createServer(controller, {
        contributionId: "acme/desk",
        connectionId,
      });

      const empty = await requestUpdate(controller, server.id, {});
      expect(empty.status).toBe(400);
      expect(await readErrorBody(empty)).toMatchObject({
        code: "validation",
        issues: [["enabled"]],
      });
      const unknown = await requestUpdate(controller, UNKNOWN_ID, { enabled: false });
      expect(unknown.status).toBe(404);
    }, PLUGINS);
  });
});

describe("mcpServer.check and mcpServer.delete", () => {
  it("refuses a check on a switched-off server and says how to switch it on", async () => {
    await withSetUpController(async (controller) => {
      const connectionId = await createDeskConnection(controller, "acme");
      const server = await createServer(controller, {
        contributionId: "acme/desk",
        connectionId,
      });
      expect((await requestCheck(controller, server.id)).status).toBe(200);
      await requestUpdate(controller, server.id, { enabled: false });

      const refused = await requestCheck(controller, server.id);

      const refusal = await readErrorBody(refused);
      expect(refused.status, refusal.text).toBe(409);
      expect(refusal.code).toBe("invalid_state");
      expect(refusal.message).toContain(`hercule mcp-server update ${server.id} --enabled true`);
    }, PLUGINS);
  });

  it("deletes a server, and refuses it once it is gone", async () => {
    await withSetUpController(async (controller) => {
      const connectionId = await createDeskConnection(controller, "acme");
      const server = await createServer(controller, {
        contributionId: "acme/desk",
        connectionId,
      });

      const deleted = await del(
        controller.base,
        `/api/v1/mcp-servers/${server.id}`,
        controller.token,
      );
      expect(deleted.status, await deleted.clone().text()).toBe(200);
      expect(await deleted.json()).toEqual({});

      const read = await get(controller.base, `/api/v1/mcp-servers/${server.id}`, controller.token);
      expect(read.status).toBe(404);
      expect((await requestCheck(controller, server.id)).status).toBe(404);
      expect(await controller.harness.audit("mcpServer.deleted")).toHaveLength(1);
    }, PLUGINS);
  });
});

describe("connection.delete while an MCP server uses the Connection", () => {
  it("is refused with the server's name, and works once the server is deleted", async () => {
    await withSetUpController(async (controller) => {
      const connectionId = await createDeskConnection(controller, "acme");
      const server = await createServer(controller, {
        contributionId: "acme/desk",
        connectionId,
        name: "work_desk",
      });
      const path = `/api/v1/connections/${connectionId}`;

      const refused = await del(controller.base, path, controller.token);

      const refusal = await readErrorBody(refused);
      expect(refused.status, refusal.text).toBe(409);
      expect(refusal.code).toBe("invalid_state");
      expect(refusal.message).toContain(`work_desk (${server.id})`);

      await del(controller.base, `/api/v1/mcp-servers/${server.id}`, controller.token);
      const deleted = await del(controller.base, path, controller.token);
      expect(deleted.status, await deleted.clone().text()).toBe(200);
    }, PLUGINS);
  });
});

describe("the grants of the MCP Server operations", () => {
  it(
    "lets mcp.read read and refuses every write without mcp.manage",
    async () => {
      await withFleet(
        async (arranged) => {
          const controller = {
            harness: arranged.harness,
            base: arranged.harness.base,
            token: arranged.token,
          };
          const connectionId = await createDeskConnection(controller, "acme");
          const server = await createServer(controller, {
            contributionId: "acme/desk",
            connectionId,
          });
          const reader = await spawnThreadUnder(
            arranged,
            await createProfile(arranged, "mcp-reader", ["mcp.read"]),
          );

          expect((await get(controller.base, "/api/v1/mcp-servers", reader.token)).status).toBe(
            200,
          );
          expect(
            (await get(controller.base, `/api/v1/mcp-servers/${server.id}`, reader.token)).status,
          ).toBe(200);
          const writes = [
            requestCreate(controller, { contributionId: "acme/desk", connectionId }, reader.token),
            send("PATCH", controller.base, `/api/v1/mcp-servers/${server.id}`, {
              body: { enabled: false },
              token: reader.token,
            }),
            del(controller.base, `/api/v1/mcp-servers/${server.id}`, reader.token),
            requestCheck(controller, server.id, reader.token),
          ];
          for (const response of await Promise.all(writes)) {
            expect(response.status).toBe(403);
            expect(await readErrorBody(response)).toMatchObject({
              code: "forbidden",
              grant: "mcp.manage",
            });
          }

          const writer = await spawnThreadUnder(
            arranged,
            await createProfile(arranged, "mcp-writer", ["mcp.manage"]),
          );
          const listed = await get(controller.base, "/api/v1/mcp-servers", writer.token);
          expect(await readErrorBody(listed)).toMatchObject({
            code: "forbidden",
            grant: "mcp.read",
          });
          expect((await requestCheck(controller, server.id, writer.token)).status).toBe(200);
        },
        { plugins: PLUGINS },
      );
    },
    WAIT_DEADLINE_MS * 3 + 10_000,
  );
});
