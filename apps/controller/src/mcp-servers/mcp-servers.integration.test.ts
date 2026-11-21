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
 *   existing one, while a Connection of another account may have its own;
 * - `query` sorts by name, and an update switches a server on and off: a
 *   switch raises the revision, switching on goes back to `checking`, and the
 *   same value writes nothing;
 * - a check on a switched-off server is refused;
 * - a delete removes the server;
 * - `mcp.read` reads and `mcp.manage` writes;
 * - `connection.delete` is refused while a server uses the Connection.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { McpServer } from "@hercule/contract";
import type { Plugin } from "@hercule/plugin-host";
import { del, get, post, readErrorBody, send } from "../http/testing";
import { buildDeskMcpServer, buildMcpServerPlugin } from "../plugins/testing";
import { WAIT_DEADLINE_MS, createProfile, spawnThreadUnder } from "../sessions/testing";
import { withFleet } from "../workspaces/testing";
import { createConnection, withSetUpController, type SetUpController } from "../workflows/testing";
import {
  createServer,
  insertPastedConnection,
  readRow,
  readServer,
  requestCheck,
  requestCreate,
  requestUpdate,
  runSql,
  startFakeUpstream,
  type FakeUpstream,
} from "./testing";

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
  PLUGINS = ["acme", "bolt"].map((id) =>
    buildMcpServerPlugin(id, { server: buildDeskMcpServer(id, upstream) }),
  );
});

afterAll(async () => {
  await upstream.stop();
});

/** A well-formed id that no MCP Server has. */
const UNKNOWN_ID = "0199e0e7-0000-7000-8000-00000000dead";

/** Creates a Connection of the `desk` type of plugin `pluginId` and returns its id. */
const createDeskConnection = (controller: SetUpController, pluginId: string): Promise<string> =>
  createConnection(controller.base, controller.token, `${pluginId}/desk`, { token: "t0ken" });

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

describe("two servers for one contribution", () => {
  it("are allowed when the Connections belong to different external accounts", async () => {
    await withSetUpController(async (controller) => {
      const first = await createDeskConnection(controller, "acme");
      const otherAccount = await insertPastedConnection(
        controller.harness,
        "acme/desk",
        "t0ken",
        "desk-2",
      );

      const one = await createServer(controller, { connectionId: first, name: "desk_one" });
      const two = await createServer(controller, { connectionId: otherAccount, name: "desk_two" });

      expect(two.id).not.toBe(one.id);
      const { items } = (await (
        await get(controller.base, "/api/v1/mcp-servers", controller.token)
      ).json()) as { items: ReadonlyArray<McpServer> };
      expect(items.map((server) => server.name)).toEqual(["desk_one", "desk_two"]);
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
        controller.harness.sql`UPDATE mcp_servers
                               SET status = 'ready', status_cause = 'x', failed_checks = 5,
                                   next_check_at = '2099-01-01T00:00:00.000Z'`,
      );
      expect((await readRow(controller)).revision).toBe(0);

      const off = await requestUpdate(controller, server.id, { enabled: false });
      expect(off.status, await off.clone().text()).toBe(200);
      // The status stays: a client shows Off from `enabled`.
      expect(await off.json()).toMatchObject({ enabled: false, status: "ready" });
      expect((await readRow(controller)).revision).toBe(1);

      const same = await requestUpdate(controller, server.id, { enabled: false });
      expect(same.status).toBe(200);
      expect((await readRow(controller)).revision).toBe(1);

      const on = await requestUpdate(controller, server.id, { enabled: true });
      expect(await on.json()).toMatchObject({ enabled: true, status: "checking" });
      // The check is due at once and the backoff is over, even if the request for it is lost.
      const switchedOn = await readRow(controller);
      expect(switchedOn.revision).toBe(2);
      expect(switchedOn.failed_checks).toBe(0);
      expect(Date.parse(switchedOn.next_check_at!)).toBeLessThanOrEqual(Date.now());
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
  it("ends the backoff of a server and raises its revision, so a running check cannot write over it", async () => {
    await withSetUpController(async (controller) => {
      const connectionId = await createDeskConnection(controller, "acme");
      const server = await createServer(controller, { contributionId: "acme/desk", connectionId });
      await runSql(controller, controller.harness.sql`UPDATE mcp_servers SET failed_checks = 3`);
      const before = await readRow(controller);

      expect((await requestCheck(controller, server.id)).status).toBe(200);

      const after = await readRow(controller);
      expect(after.failed_checks).toBe(0);
      expect(after.revision).toBe(before.revision + 1);
      // Nothing the record shows changed.
      expect(after.updated_at).toBe(before.updated_at);
    }, PLUGINS);
  });

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
            post(
              controller.base,
              `/api/v1/mcp-servers/${server.id}/token`,
              { token: "tok-3f9a1c7e5b2d" },
              reader.token,
            ),
            post(
              controller.base,
              "/api/v1/mcp-servers",
              { source: { kind: "url", url: "https://mcp.example.com/mcp" } },
              reader.token,
            ),
            // Replace: moves a server added by address onto a Connection.
            send("PATCH", controller.base, `/api/v1/mcp-servers/${server.id}`, {
              body: { source: { kind: "plugin", contributionId: "acme/desk", connectionId } },
              token: reader.token,
            }),
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
