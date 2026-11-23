/**
 * Tests adding an MCP Server by its address, and giving it a token, over HTTP
 * against a real controller and a fake outside MCP server that speaks the
 * protocol for real:
 *
 * - a create with no sign-in goes `checking` and then `ready`, and one with a
 *   token sends it as a bearer token from the first check;
 * - an address that was added before is refused whatever its spelling, naming
 *   the server, and two creates that run at once give one server and one
 *   refusal, for an address and for a plugin's account;
 * - an address on a plugin's origin is refused in three ways, by what the user
 *   has: a Connection, none, or a plugin that is off or failed to start;
 * - `setToken` takes a server out of `needs-sign-in`, ends the upstream
 *   session opened with the old sign-in, and is refused for a plugin server;
 * - a delete removes the sign-in secrets, and the token is in no answer, no
 *   audit entry, no Notification and no row of the database;
 * - a URL server that needs sign-in raises no Notification before it has
 *   worked, and one per episode after that.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { McpProtocol } from "effect/ai";
import type { McpServer } from "@hercule/contract";
import { PluginError } from "@hercule/plugin-host";
import { uuidFromString } from "../db";
import { del, get, post } from "../http/testing";
import { buildDeskMcpServer, buildMcpServerPlugin } from "../plugins/testing";
import { disablePlugin, withSetUpController, type SetUpController } from "../workflows/testing";
import {
  countNotifications,
  insertPastedConnection,
  readRow,
  requestUpdate,
  runSql,
  startFakeUpstream,
  waitForResult,
  withRig,
  withUrlRig,
  callAs,
  readRecord,
  readRefusal,
  sendToken,
  waitForStatus,
} from "./testing";

const TOKEN = "tok-3f9a1c7e5b2d";

/** Sends `mcpServer.create` for an address and returns the raw response. */
const createByAddress = (
  controller: SetUpController,
  source: { readonly url: string; readonly name?: string; readonly token?: string },
) =>
  post(
    controller.base,
    "/api/v1/mcp-servers",
    { source: { kind: "url", ...source } },
    controller.token,
  );

/** Returns every row of every table as one text, so a test can look for a value anywhere in the database. */
const dumpDatabase = (controller: SetUpController): Promise<string> =>
  runSql(
    controller,
    Effect.gen(function* () {
      const sql = controller.harness.sql;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`;
      const dumped: Array<unknown> = [];
      for (const { name } of tables) {
        dumped.push(yield* sql`SELECT * FROM ${sql(name)}`);
      }
      return JSON.stringify(dumped);
    }),
  );

const countServers = async (controller: SetUpController): Promise<number> => {
  const rows = await runSql(
    controller,
    controller.harness.sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM mcp_servers`,
  );
  return rows[0]!.n;
};

describe("creating a server by its address", () => {
  it("answers in status checking with no sign-in, then lists the tools with no Authorization header", async () => {
    await withUrlRig(async ({ controller, fake }) => {
      const server = await readRecord(
        await createByAddress(controller, { url: fake.url, name: "remote" }),
      );

      expect(server).toMatchObject({
        name: "remote",
        source: { kind: "url", url: fake.url, signIn: "none", signInOffered: null },
        enabled: true,
        status: "checking",
        statusDetail: null,
        tools: [],
      });
      const row = await waitForResult(controller);
      expect(row.status).toBe("ready");
      expect(new Set(fake.requests.map((request) => request.authorization))).toEqual(
        new Set([null]),
      );

      const [audited] = await controller.harness.audit("mcpServer.created");
      expect(audited?.payload).toEqual({
        mcpServerId: server.id,
        sourceKind: "url",
        url: fake.url,
      });
    });
  });

  it("shows the address whole, query included, and calls the server at it", async () => {
    await withUrlRig(async ({ controller, fake }) => {
      const created = await readRecord(
        await createByAddress(controller, {
          url: `${fake.url}?api_key=k3y-9f2a7c&org=acme`,
          name: "remote",
        }),
      );
      await waitForResult(controller);

      const read = await readRecord(
        await get(controller.base, `/api/v1/mcp-servers/${created.id}`, controller.token),
      );
      const listed = (await (
        await get(controller.base, "/api/v1/mcp-servers", controller.token)
      ).json()) as { items: ReadonlyArray<McpServer> };

      for (const server of [created, read, listed.items[0]!]) {
        expect(server.source).toMatchObject({ url: `${fake.url}?api_key=k3y-9f2a7c&org=acme` });
      }
      expect(fake.requests.map((request) => request.url)).toContain(
        "/mcp?api_key=k3y-9f2a7c&org=acme",
      );
    });
  });

  it("names the server after the first label of the host that is not mcp, www or api", async () => {
    await withUrlRig(async ({ controller, fake }) => {
      // The fake listens on 127.0.0.1, whose first label passes the name rule.
      const server = await readRecord(await createByAddress(controller, { url: fake.url }));
      expect(server.name).toBe("127");
    });
  });

  it("sends a token it was given as a bearer token from the first check", async () => {
    await withUrlRig(async ({ controller, fake }) => {
      fake.authorize = (authorization) => authorization === `Bearer ${TOKEN}`;
      const address = `${fake.url}?api_key=k3y9f2a7c&org=acme`;

      const server = await readRecord(
        await createByAddress(controller, { url: address, name: "remote", token: TOKEN }),
      );

      expect(server.source).toMatchObject({ kind: "url", signIn: "token" });
      expect((await waitForResult(controller)).status).toBe("ready");
      expect(new Set(fake.requests.map((request) => request.authorization))).toEqual(
        new Set([`Bearer ${TOKEN}`]),
      );

      // The audit entry holds the whole address, query included, and never the token.
      const [audited] = await controller.harness.audit("mcpServer.created");
      expect(audited?.payload).toEqual({
        mcpServerId: server.id,
        sourceKind: "url",
        url: address,
      });
      expect(JSON.stringify(audited)).not.toContain(TOKEN);
    });
  });

  it("refuses what is not an address, naming the field", async () => {
    await withUrlRig(async ({ controller }) => {
      for (const url of [
        "ftp://example.com/mcp",
        "https://me:pw@example.com/",
        "https://a.com/#x",
      ]) {
        const refusal = await readRefusal(await createByAddress(controller, { url }), 400);
        expect(refusal.code, url).toBe("validation");
        expect(refusal.details, url).toMatchObject({ issues: [{ path: ["source", "url"] }] });
      }
      const noName = await readRefusal(
        await createByAddress(controller, { url: "https://hercule.example.com/mcp" }),
        400,
      );
      expect(noName.details).toMatchObject({ issues: [{ path: ["source", "name"] }] });
      expect(JSON.stringify(noName.details)).toContain("--name");
      expect(await countServers(controller)).toBe(0);
    });
  });
});

describe("an address that was added before", () => {
  it("is refused in every spelling, with details that name the existing server", async () => {
    await withUrlRig(async ({ controller, fake }) => {
      const first = await readRecord(
        await createByAddress(controller, { url: fake.url, name: "remote" }),
      );
      const spellings = [
        fake.url,
        `${fake.url}/`,
        fake.url.replace("http://", "HTTP://"),
        `  ${fake.url}  `,
      ];

      for (const url of spellings) {
        const refusal = await readRefusal(
          await createByAddress(controller, { url, name: "again" }),
          409,
        );
        expect(refusal, url).toMatchObject({
          code: "conflict",
          message: `You added this server before, as remote (${first.id}). One address is one server: use that one, or delete it first with \`hercule mcp-server delete ${first.id}\`.`,
          details: { reason: "mcp-server-exists", mcpServerId: first.id },
        });
      }
      expect(await countServers(controller)).toBe(1);
    });
  });

  it("is told apart from another address by its query", async () => {
    await withUrlRig(async ({ controller, fake }) => {
      await readRecord(await createByAddress(controller, { url: fake.url, name: "one" }));
      await readRecord(await createByAddress(controller, { url: `${fake.url}?a=1`, name: "two" }));
      expect(await countServers(controller)).toBe(2);
    });
  });

  it("gives one server and one refusal when two creates run at once, in two spellings", async () => {
    await withUrlRig(async ({ controller, fake }) => {
      const responses = await Promise.all([
        createByAddress(controller, { url: fake.url, name: "one" }),
        createByAddress(controller, { url: `${fake.url}/`, name: "two" }),
      ]);

      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([200, 409]);
      const winner = await readRecord(responses.find((response) => response.status === 200)!);
      const loser = await readRefusal(
        responses.find((response) => response.status === 409)!,
        409,
      );
      expect(loser.details).toEqual({ reason: "mcp-server-exists", mcpServerId: winner.id });
      expect(await countServers(controller)).toBe(1);
    });
  });
});

describe("a plugin's server for an account", () => {
  it("gives one server and one refusal, with details, when two creates run at once", async () => {
    await withRig(async ({ controller, connect }) => {
      const connectionId = await connect();
      const create = () =>
        post(
          controller.base,
          "/api/v1/mcp-servers",
          { source: { kind: "plugin", contributionId: "acme/desk", connectionId } },
          controller.token,
        );

      const responses = await Promise.all([create(), create()]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const winner = await readRecord(responses.find((response) => response.status === 200)!);
      const loser = await readRefusal(
        responses.find((response) => response.status === 409)!,
        409,
      );
      expect(loser.details).toEqual({ reason: "mcp-server-exists", mcpServerId: winner.id });
    });
  });
});

describe("an address on a plugin's origin", () => {
  it("is refused with the Connection to switch the server on from, when the user has one", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      const connectionId = await connect();

      const refusal = await readRefusal(
        await createByAddress(controller, { url: `${fake.url}?x=1`, name: "remote" }),
        409,
      );

      expect(refusal.details).toEqual({
        reason: "mcp-server-on-plugin-origin",
        contributionId: "acme/desk",
        connectionId,
        pluginState: "active",
      });
      expect(refusal.message).toBe(
        `${fake.origin} is the Desk MCP server. It is reached with your Desk Connection work, with no second sign-in: switch it on in Settings > MCP servers, or run \`hercule mcp-server create --plugin acme/desk --connection ${connectionId}\`.`,
      );
      expect(await countServers(controller)).toBe(0);
    });
  });

  it("points at a connected Connection before one that needs to sign in or is switched off", async () => {
    await withRig(async ({ controller, fake }) => {
      const insert = (accountId: string, status: string) =>
        insertPastedConnection(controller.harness, "acme/desk", "t0ken-abcd", accountId).then(
          async (id) => {
            await runSql(
              controller,
              controller.harness.sql`UPDATE connections SET status = ${status}
                                     WHERE id = ${uuidFromString(id)}`,
            );
            return id;
          },
        );
      await insert("desk-a", "disabled");
      await insert("desk-b", "needs-reauth");
      const connected = await insert("desk-c", "connected");

      const refusal = await readRefusal(
        await createByAddress(controller, { url: fake.url, name: "remote" }),
        409,
      );

      expect(refusal.details).toEqual({
        reason: "mcp-server-on-plugin-origin",
        contributionId: "acme/desk",
        connectionId: connected,
        pluginState: "active",
      });
      expect(refusal.message).toContain(
        `\`hercule mcp-server create --plugin acme/desk --connection ${connected}\``,
      );
    });
  });

  it.each([
    [
      "needs-reauth",
      "which needs to sign in again: reconnect it in Settings > Connections first, then switch its server on in Settings > MCP servers.",
    ],
    [
      "error",
      "which is in error: check it in Settings > Connections first, then switch its server on in Settings > MCP servers.",
    ],
    [
      "disabled",
      "which is switched off: switch it on in Settings > Connections first, then switch its server on in Settings > MCP servers.",
    ],
  ])(
    "points at the Connection to fix first, with no command to run, when its only Connection is %s",
    async (status, advice) => {
      await withRig(async ({ controller, fake, connect }) => {
        const connectionId = await connect();
        await runSql(controller, controller.harness.sql`UPDATE connections SET status = ${status}`);

        const refusal = await readRefusal(
          await createByAddress(controller, { url: fake.url, name: "remote" }),
          409,
        );

        expect(refusal.details).toEqual({
          reason: "mcp-server-on-plugin-origin",
          contributionId: "acme/desk",
          connectionId,
          pluginState: "active",
        });
        expect(refusal.message).toBe(
          `${fake.origin} is the Desk MCP server. It is reached with your Desk Connection work, ${advice}`,
        );
        expect(refusal.message).not.toContain("hercule mcp-server create");
      });
    },
  );

  it("is refused with a pointer to Settings > Connections, when the user has no Connection", async () => {
    await withRig(async ({ controller, fake }) => {
      const refusal = await readRefusal(
        await createByAddress(controller, { url: fake.url, name: "remote" }),
        409,
      );

      expect(refusal.details).toEqual({
        reason: "mcp-server-on-plugin-origin",
        contributionId: "acme/desk",
        connectionId: null,
        pluginState: "active",
      });
      expect(refusal.message).toBe(
        `${fake.origin} is the Desk MCP server. It is reached with a Desk Connection, with no second sign-in. Connect Desk first in Settings > Connections, then switch its server on in Settings > MCP servers.`,
      );
    });
  });

  it("is refused with a pointer to Settings > Plugins, when the plugin is switched off", async () => {
    await withRig(async ({ controller, fake }) => {
      await disablePlugin(controller.base, controller.token, "acme");

      const refusal = await readRefusal(
        await createByAddress(controller, { url: fake.url, name: "remote" }),
        409,
      );

      expect(refusal.details).toMatchObject({
        reason: "mcp-server-on-plugin-origin",
        contributionId: "acme/desk",
        connectionId: null,
        pluginState: "switched-off",
      });
      expect(refusal.message).toBe(
        `${fake.origin} is the Desk MCP server. The Desk plugin is switched off: switch it on in Settings > Plugins, connect it, then switch its server on in Settings > MCP servers.`,
      );
    });
  });

  it("is refused in the words of a plugin that failed to start", async () => {
    const fake = await startFakeUpstream();
    try {
      const plugin = {
        ...buildMcpServerPlugin("acme", { server: buildDeskMcpServer("acme", fake) }),
        activate: () => Effect.fail(new PluginError({ message: "no network" })),
      };
      await withSetUpController(
        async (controller) => {
          const refusal = await readRefusal(
            await createByAddress(controller, { url: fake.url, name: "remote" }),
            409,
          );

          expect(refusal.details).toMatchObject({ pluginState: "failed-to-start" });
          expect(refusal.message).toBe(
            `${fake.origin} is the Desk MCP server. The Desk plugin failed to start: see Settings > Plugins. Once it runs, connect it, then switch its server on in Settings > MCP servers.`,
          );
        },
        [plugin],
      );
    } finally {
      await fake.stop();
    }
  });
});

describe("giving a server a token", () => {
  it("takes a server out of needs-sign-in, checks it with the token, and writes no token anywhere", async () => {
    await withUrlRig(async ({ controller, fake }) => {
      fake.authorize = (authorization) => authorization === `Bearer ${TOKEN}`;
      const created = await readRecord(
        await createByAddress(controller, { url: fake.url, name: "remote" }),
      );
      const refused = await waitForStatus(controller, "needs-sign-in");
      expect(refused.sign_in_offered).toBe("token");

      const answered = await readRecord(await sendToken(controller, created.id, TOKEN));

      expect(answered).toMatchObject({
        id: created.id,
        status: "checking",
        statusDetail: null,
        source: { kind: "url", signIn: "token", signInOffered: "token" },
      });
      const ready = await waitForStatus(controller, "ready");
      expect(ready.revision).toBeGreaterThan(refused.revision);
      expect(fake.requests.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);

      const [updated] = await controller.harness.audit("mcpServer.updated");
      expect(updated?.payload).toEqual({ mcpServerId: created.id, signIn: "token" });
      expect(await dumpDatabase(controller)).not.toContain(TOKEN);
      expect(JSON.stringify(answered)).not.toContain(TOKEN);
      expect(
        JSON.stringify(
          await (await get(controller.base, `/api/v1/mcp-servers`, controller.token)).json(),
        ),
      ).not.toContain(TOKEN);
    });
  });

  it("ends the upstream session opened with the old sign-in", async () => {
    await withUrlRig(
      async ({ controller, fake }) => {
        const created = await readRecord(
          await createByAddress(controller, { url: fake.url, name: "remote", token: "old-token" }),
        );
        await waitForResult(controller);
        expect((await callAs(controller, created.id))._tag).toBe("Success");

        await readRecord(await sendToken(controller, created.id, "new-token"));
        await waitForStatus(controller, "ready");
        expect((await callAs(controller, created.id))._tag).toBe("Success");

        const calls = fake.requests.filter((request) => request.method === "tools/call");
        expect(calls.map((call) => call.authorization)).toEqual([
          "Bearer old-token",
          "Bearer new-token",
        ]);
        expect(calls[1]?.sessionId).not.toBe(calls[0]?.sessionId);
      },
      { fake: { protocols: [McpProtocol.v2025_11_25] } },
    );
  });

  it("stores the token of a switched-off server and writes checking, without a check until it is switched on", async () => {
    await withUrlRig(async ({ controller, fake }) => {
      fake.authorize = (authorization) => authorization === `Bearer ${TOKEN}`;
      const created = await readRecord(
        await createByAddress(controller, { url: fake.url, name: "remote" }),
      );
      const refused = await waitForStatus(controller, "needs-sign-in");
      expect((await requestUpdate(controller, created.id, { enabled: false })).status).toBe(200);
      const requestsBefore = fake.requests.length;

      const answered = await readRecord(await sendToken(controller, created.id, TOKEN));

      expect(answered).toMatchObject({
        enabled: false,
        status: "checking",
        statusDetail: null,
        source: { kind: "url", signIn: "token" },
      });
      // No check runs for a server that is off, so nothing is sent.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(fake.requests).toHaveLength(requestsBefore);
      expect((await readRow(controller)).revision).toBeGreaterThan(refused.revision);

      expect((await requestUpdate(controller, created.id, { enabled: true })).status).toBe(200);
      await waitForStatus(controller, "ready");
      expect(fake.requests.at(-1)?.authorization).toBe(`Bearer ${TOKEN}`);
    });
  });

  it("is refused for a plugin server, naming the Connection to reconnect", async () => {
    await withRig(async ({ controller, connect }) => {
      const connectionId = await connect();
      const server = await readRecord(
        await post(
          controller.base,
          "/api/v1/mcp-servers",
          { source: { kind: "plugin", contributionId: "acme/desk", connectionId } },
          controller.token,
        ),
      );

      const refusal = await readRefusal(await sendToken(controller, server.id, TOKEN), 409);

      expect(refusal).toMatchObject({
        code: "invalid_state",
        message:
          "this server is reached with the Connection work; reconnect that Connection in Settings > Connections instead",
      });
      expect(await controller.harness.audit("mcpServer.updated")).toEqual([]);
    });
  });

  it("is refused for no server, and for an empty token", async () => {
    await withUrlRig(async ({ controller, fake }) => {
      const unknown = "0199e0e7-0000-7000-8000-00000000dead";
      expect((await readRefusal(await sendToken(controller, unknown, TOKEN), 404)).code).toBe(
        "not_found",
      );

      const created = await readRecord(
        await createByAddress(controller, { url: fake.url, name: "remote" }),
      );
      expect((await readRefusal(await sendToken(controller, created.id, ""), 400)).code).toBe(
        "validation",
      );
    });
  });
});

describe("a pasted token", () => {
  // Each text is refused whatever the operation, because the rule lives in the
  // contract. The first four are what a user pastes by mistake.
  const refusedTokens: ReadonlyArray<readonly [string, string]> = [
    ["with Bearer in front", "Bearer abc12345"],
    ["with a space inside", "abc 12345678"],
    ["with a newline at the end", "abc12345678\n"],
    ["with a character outside printable ASCII", "abc12345\u00e9"],
    ["of 7 characters, which could be a part of the marker that replaces a secret", "removed"],
    ["a part of the marker that replaces a secret", "[removed"],
    ["that is empty", ""],
  ];

  it("accepts a token with characters outside RFC 6750's b64token, as Notion's access tokens have", async () => {
    await withUrlRig(async ({ controller, fake }) => {
      const created = await readRecord(
        await createByAddress(controller, { url: fake.url, name: "remote" }),
      );
      const updated = await readRecord(
        await sendToken(controller, created.id, "6f1c2a9e-1b2c:ab12cd34:EF56_gh78"),
      );
      expect(updated.source).toMatchObject({ kind: "url", signIn: "token" });
    });
  });

  it.each(refusedTokens)(
    "is refused as validation when it is %s, without repeating it",
    async (_why, token) => {
      await withUrlRig(async ({ controller, fake }) => {
        const created = await readRecord(
          await createByAddress(controller, { url: fake.url, name: "remote" }),
        );

        const onCreate = await readRefusal(
          await createByAddress(controller, { url: `${fake.url}?other=1`, name: "other", token }),
          400,
        );
        const onSet = await readRefusal(await sendToken(controller, created.id, token), 400);

        for (const [refusal, path] of [
          [onCreate, ["source", "token"]],
          [onSet, ["token"]],
        ] as const) {
          expect(refusal.code).toBe("validation");
          expect(refusal.details).toMatchObject({ issues: [{ path }] });
          const shown = JSON.stringify(refusal);
          expect(shown).toContain("without `Bearer ` in front of it");
          // A token that is not valid is never repeated, so nothing that holds
          // a secret by mistake echoes it back.
          if (token !== "") expect(shown).not.toContain(token);
        }
        expect(await countServers(controller)).toBe(1);
      });
    },
  );

  it.each(["abc12345", "tok-3f9a1c7e5b2d", "eyJhbGciOi.J9_x~y+z/0", "dGVzdA=="])(
    "is accepted when it is %s",
    async (token) => {
      await withUrlRig(async ({ controller, fake }) => {
        const created = await readRecord(
          await createByAddress(controller, { url: fake.url, name: "remote", token }),
        );

        expect(created.source).toMatchObject({ signIn: "token" });
        expect((await sendToken(controller, created.id, token)).status).toBe(200);
      });
    },
  );
});

describe("deleting a server added by its address", () => {
  it("removes its sign-in secrets", async () => {
    await withUrlRig(async ({ controller, fake }) => {
      const created = await readRecord(
        await createByAddress(controller, { url: fake.url, name: "remote", token: TOKEN }),
      );
      const countSecrets = async () =>
        (
          await runSql(
            controller,
            controller.harness.sql<{ readonly n: number }>`
              SELECT COUNT(*) AS n FROM secrets
              WHERE owner_kind = 'mcp-server' AND owner_id = ${created.id}`,
          )
        )[0]!.n;
      expect(await countSecrets()).toBe(1);

      expect(
        (await del(controller.base, `/api/v1/mcp-servers/${created.id}`, controller.token)).status,
      ).toBe(200);

      expect(await countSecrets()).toBe(0);
    });
  });
});

describe("a server added by its address that needs sign-in", () => {
  const readNotificationBodies = (controller: SetUpController) =>
    runSql(
      controller,
      controller.harness.sql<{ readonly title: string; readonly body: string | null }>`
        SELECT title, body FROM notifications WHERE kind = 'core.mcp-server-failed'`,
    );

  it("raises none while it has never worked, and one per episode after that", async () => {
    await withUrlRig(async ({ controller, fake }) => {
      fake.authorize = (authorization) => authorization === `Bearer ${TOKEN}`;
      const created = await readRecord(
        await createByAddress(controller, { url: fake.url, name: "remote" }),
      );

      // Added with no token, the first check gets a 401: whoever adds the
      // server sees that, so it raises no Notification, and a wrong token
      // is another refusal of a server that never worked.
      await waitForStatus(controller, "needs-sign-in");
      expect(await countNotifications(controller)).toBe(0);
      await sendToken(controller, created.id, "wrong-token");
      await waitForStatus(controller, "needs-sign-in");
      expect(await countNotifications(controller)).toBe(0);

      // Once it has worked, its next refusal opens an episode.
      await sendToken(controller, created.id, TOKEN);
      await waitForStatus(controller, "ready");
      fake.authorize = () => false;
      await post(controller.base, `/api/v1/mcp-servers/${created.id}/check`, {}, controller.token);
      await waitForStatus(controller, "needs-sign-in");
      expect(await countNotifications(controller)).toBe(1);
      expect((await readNotificationBodies(controller))[0]?.title).toBe(
        "MCP server remote needs a sign-in",
      );

      // A wrong token is another refusal in the same episode.
      await sendToken(controller, created.id, "wrong-token");
      await waitForStatus(controller, "needs-sign-in");
      expect(await countNotifications(controller)).toBe(1);

      // Recovering ends the episode, and the next refusal opens a new one.
      fake.authorize = (authorization) => authorization === `Bearer ${TOKEN}`;
      await sendToken(controller, created.id, TOKEN);
      await waitForStatus(controller, "ready");
      fake.authorize = () => false;
      await post(controller.base, `/api/v1/mcp-servers/${created.id}/check`, {}, controller.token);
      await waitForStatus(controller, "needs-sign-in");
      expect(await countNotifications(controller)).toBe(2);

      expect(JSON.stringify(await readNotificationBodies(controller))).not.toContain(TOKEN);
    });
  });
});
