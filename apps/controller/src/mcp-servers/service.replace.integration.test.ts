/**
 * Tests Replace, `mcpServer.update` with a `source`, over HTTP against a real
 * controller and a fake outside MCP server that is both a plugin's server and
 * the address a server was added at:
 *
 * - the server keeps its id, name, stored tools and every list that names it,
 *   becomes a plugin server of the Connection, loses its address and its
 *   sign-in secrets, and is checked through the Connection;
 * - an upstream MCP session opened before is not used again;
 * - every refusal leaves the server as it was;
 * - `enabled` and `source` may come together;
 * - Replace and a create of the same plugin server that run at once give one
 *   winner and one typed `conflict`.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { McpProtocol } from "effect/ai";
import type { Project, McpServer, Session } from "@hercule/contract";
import { createConnection } from "../workflows/testing";
import { get } from "../http/testing";
import { withTransaction } from "../db";
import { sessionRepository } from "../sessions";
import { createProfile, spawnThreadUnder, WAIT_DEADLINE_MS } from "../sessions/testing";
import { withFleet } from "../workspaces/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { buildDeskMcpServer, buildMcpServerPlugin } from "../plugins/testing";
import type { SetUpController } from "../workflows/testing";
import {
  countNotifications,
  createProject,
  createServer,
  eventually,
  insertPastedConnection,
  insertUrlServerAt,
  readProject,
  readRow,
  requestCheck,
  requestCreate,
  requestUpdate,
  runSql,
  startFakeUpstream,
  waitForResult,
  withRig,
  type FakeUpstream,
} from "./testing";

const OLD_TOKEN = "old-token-1234";
const UNKNOWN_ID = "0199e0e7-0000-7000-8000-00000000dead";

/** The `source` of a Replace onto the test plugin's server. */
const replaceSource = (connectionId: string, contributionId = "acme/desk") => ({
  source: { kind: "plugin", contributionId, connectionId },
});

/** Reads a response that must be a success, as a server record. */
const readRecord = async (response: Response): Promise<McpServer> => {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as McpServer;
};

/** Reads a response that must be an error, and returns its envelope. */
const readRefusal = async (response: Response, status: number) => {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return (
    JSON.parse(text) as {
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details?: Record<string, unknown>;
      };
    }
  ).error;
};

/** Reads the columns of the only server that Replace writes. */
const readSourceColumns = (controller: Pick<SetUpController, "harness">, id: string) =>
  runSql(
    controller,
    controller.harness.sql<{
      readonly source_kind: string;
      readonly contribution_id: string | null;
      readonly url: string | null;
      readonly normalized_url: string | null;
      readonly sign_in: string | null;
      readonly sign_in_offered: string | null;
      readonly account_id: string | null;
      readonly protocol_version: string | null;
      readonly status: string;
      readonly revision: number;
    }>`SELECT source_kind, contribution_id, url, normalized_url, sign_in, sign_in_offered,
              account_id, protocol_version, status, revision
       FROM mcp_servers WHERE lower(hex(id)) = ${id.replaceAll("-", "")}`,
  ).then((rows) => rows[0]!);

const countSecrets = async (controller: Pick<SetUpController, "harness">, id: string) =>
  (
    await runSql(
      controller,
      controller.harness.sql<{ readonly n: number }>`
        SELECT COUNT(*) AS n FROM secrets WHERE owner_kind = 'mcp-server' AND owner_id = ${id}`,
    )
  )[0]!.n;

const callEcho = (controller: SetUpController, serverId: string) =>
  Effect.runPromise(
    Effect.result(
      controller.harness.mcpServerCalls.callTool({
        upstreamScope: "scope-replace",
        serverId,
        tool: "echo",
        arguments: { text: "hi" },
        authorize: Effect.void,
      }),
    ),
  );

describe("Replace", () => {
  it("keeps the id, the name and the stored tools, clears the address and the secrets, and checks through the Connection", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      const connectionId = await connect();
      const id = await insertUrlServerAt(controller, fake.url, { token: OLD_TOKEN });
      expect((await requestCheck(controller, id)).status).toBe(200);
      const listed = await waitForResult(controller);
      expect(listed.status).toBe("ready");
      expect(await countSecrets(controller, id)).toBe(1);
      const release = fake.hold("tools/list");

      const replaced = await readRecord(
        await requestUpdate(controller, id, replaceSource(connectionId)),
      );

      expect(replaced).toMatchObject({
        id,
        name: "remote",
        source: { kind: "plugin", contributionId: "acme/desk", connectionId },
        enabled: true,
        status: "checking",
        tools: [{ name: "echo", description: "Echoes its text" }],
      });
      const columns = await readSourceColumns(controller, id);
      expect(columns).toMatchObject({
        source_kind: "plugin",
        contribution_id: "acme/desk",
        url: null,
        normalized_url: null,
        sign_in: null,
        sign_in_offered: null,
        account_id: "desk-1",
        protocol_version: null,
        status: "checking",
      });
      expect(columns.revision).toBeGreaterThan(listed.revision);
      expect(await countSecrets(controller, id)).toBe(0);
      const [updated] = await controller.harness.audit("mcpServer.updated");
      expect(updated?.payload).toEqual({
        mcpServerId: id,
        sourceKind: "plugin",
        contributionId: "acme/desk",
        connectionId,
      });

      release();
      const checked = await eventually(
        () => readRow(controller),
        (row) => row.status === "ready",
      );
      expect(checked.protocol_version).not.toBeNull();
      expect(fake.requests.at(-1)?.authorization).toBe("Bearer t0ken");
      expect(JSON.stringify(await controller.harness.audit("mcpServer.updated"))).not.toContain(
        OLD_TOKEN,
      );
    });
  });

  it("sends nothing more on the upstream session opened before it, and replaces that session at the next call", async () => {
    await withRig(
      async ({ controller, fake, connect }) => {
        const connectionId = await connect();
        const id = await insertUrlServerAt(controller, fake.url, { token: OLD_TOKEN });
        expect((await requestCheck(controller, id)).status).toBe(200);
        await waitForResult(controller);
        expect((await callEcho(controller, id))._tag).toBe("Success");
        const oldSessionId = fake.requests.find(
          (request) => request.method === "tools/call",
        )?.sessionId;
        expect(oldSessionId).not.toBeNull();
        const requestsOfOldSession = fake.requests.filter(
          (request) => request.sessionId === oldSessionId,
        ).length;

        await readRecord(await requestUpdate(controller, id, replaceSource(connectionId)));
        await eventually(
          () => readRow(controller),
          (row) => row.status === "ready" && row.protocol_version !== null,
        );

        // The controller closes the old session when the Replace commits. It
        // sends no DELETE for it, because the revision that session was opened
        // with is gone and a request of it may carry its token only until
        // then (spec 21 section 5.2). Nothing reaches the old session, and no
        // call has asked for a new one yet.
        expect(fake.requests.filter((request) => request.sessionId === oldSessionId)).toHaveLength(
          requestsOfOldSession,
        );
        expect(fake.requests.filter((request) => request.method === "tools/call")).toHaveLength(1);

        expect((await callEcho(controller, id))._tag).toBe("Success");

        const calls = fake.requests.filter((request) => request.method === "tools/call");
        expect(calls.map((call) => call.authorization)).toEqual([
          `Bearer ${OLD_TOKEN}`,
          "Bearer t0ken",
        ]);
        expect(calls[1]?.sessionId).not.toBe(calls[0]?.sessionId);
      },
      { fake: { protocols: [McpProtocol.v2025_11_25] } },
    );
  });

  it("takes enabled in the same call, and writes one audit entry that says so", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      const connectionId = await connect();
      const id = await insertUrlServerAt(controller, fake.url);

      const replaced = await readRecord(
        await requestUpdate(controller, id, { enabled: false, ...replaceSource(connectionId) }),
      );

      expect(replaced).toMatchObject({ id, enabled: false, source: { kind: "plugin" } });
      expect(await controller.harness.audit("mcpServer.updated")).toMatchObject([
        { payload: { mcpServerId: id, sourceKind: "plugin", connectionId, enabled: false } },
      ]);
    });
  });

  it("is refused with validation when it gives neither enabled nor source", async () => {
    await withRig(async ({ controller, fake }) => {
      const id = await insertUrlServerAt(controller, fake.url);

      const refusal = await readRefusal(await requestUpdate(controller, id, {}), 400);

      expect(refusal.code).toBe("validation");
    });
  });
});

describe("a Replace of a server whose Notification is open", () => {
  it("raises no second Notification while the server fails, and a new one after it was ready", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      const connectionId = await connect();
      fake.authorize = () => false;
      const id = await insertUrlServerAt(controller, fake.url);
      expect((await requestCheck(controller, id)).status).toBe(200);
      await eventually(
        () => readRow(controller),
        (row) => row.status === "needs-sign-in",
      );
      expect(await countNotifications(controller)).toBe(1);

      // The Connection's endpoint fails: the episode that began on the address goes on.
      fake.authorize = () => true;
      fake.refuseWithStatus = 503;
      await readRecord(await requestUpdate(controller, id, replaceSource(connectionId)));
      const failing = await eventually(
        () => readRow(controller),
        (row) => row.status !== "checking" && row.status !== "needs-sign-in",
      );
      expect(failing.status).toBe("unreachable");
      expect(await countNotifications(controller)).toBe(1);

      // Ready ends the episode, so the next failure raises a new Notification.
      fake.refuseWithStatus = undefined;
      expect((await requestCheck(controller, id)).status).toBe(200);
      await eventually(
        () => readRow(controller),
        (row) => row.status === "ready",
      );
      fake.refuseWithStatus = 503;
      expect((await requestCheck(controller, id)).status).toBe(200);
      await eventually(
        () => readRow(controller),
        (row) => row.status === "unreachable",
      );
      expect(await countNotifications(controller)).toBe(2);
    });
  });
});

describe("a Replace that is refused", () => {
  it("leaves the server and its sign-in as they were", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      const connectionId = await connect();
      const id = await insertUrlServerAt(controller, fake.url, { token: OLD_TOKEN });
      const other = await insertUrlServerAt(controller, "http://127.0.0.1:1/mcp", {
        name: "elsewhere",
      });
      const wrongType = await insertPastedConnection(
        controller.harness,
        "acme/other",
        "t0ken-1234",
        "desk-2",
      );
      const before = await readSourceColumns(controller, id);

      const unknownServer = await readRefusal(
        await requestUpdate(controller, UNKNOWN_ID, replaceSource(connectionId)),
        404,
      );
      const unknownContribution = await readRefusal(
        await requestUpdate(controller, id, replaceSource(connectionId, "acme/nothing")),
        400,
      );
      const unknownConnection = await readRefusal(
        await requestUpdate(controller, id, replaceSource(UNKNOWN_ID)),
        400,
      );
      const wrongConnection = await readRefusal(
        await requestUpdate(controller, id, replaceSource(wrongType)),
        400,
      );
      const elsewhere = await readRefusal(
        await requestUpdate(controller, other, replaceSource(connectionId)),
        400,
      );

      expect(unknownServer.code).toBe("not_found");
      expect(unknownContribution).toMatchObject({
        code: "validation",
        details: { issues: [{ path: ["source", "contributionId"] }] },
      });
      expect(unknownConnection).toMatchObject({
        code: "validation",
        details: { issues: [{ path: ["source", "connectionId"], message: "no such connection" }] },
      });
      expect(wrongConnection).toMatchObject({
        code: "validation",
        details: { issues: [{ path: ["source", "connectionId"] }] },
      });
      expect(elsewhere).toMatchObject({
        code: "validation",
        details: {
          issues: [
            {
              path: ["source", "contributionId"],
              message: `this server's address is not on ${fake.origin}, the address the Desk server is reached at`,
            },
          ],
        },
      });
      expect(await readSourceColumns(controller, id)).toEqual(before);
      expect(await countSecrets(controller, id)).toBe(1);
      expect(await controller.harness.audit("mcpServer.updated")).toEqual([]);
    });
  });

  it("is refused with invalid_state for a server that is reached with a Connection already", async () => {
    await withRig(async ({ controller, connect }) => {
      const connectionId = await connect();
      const server = await createServer(controller, { connectionId });

      const refusal = await readRefusal(
        await requestUpdate(controller, server.id, replaceSource(connectionId)),
        409,
      );

      expect(refusal).toMatchObject({
        code: "invalid_state",
        message:
          "this server is already reached with a Connection; Replace moves a server added by address",
      });
    });
  });

  it("is refused with conflict, naming the server, when the plugin has one for the account", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      const connectionId = await connect();
      const existing = await createServer(controller, { connectionId });
      const id = await insertUrlServerAt(controller, fake.url, { token: OLD_TOKEN });

      const refusal = await readRefusal(
        await requestUpdate(controller, id, replaceSource(connectionId)),
        409,
      );

      expect(refusal.code).toBe("conflict");
      expect(refusal.details).toEqual({ reason: "mcp-server-exists", mcpServerId: existing.id });
      expect((await readSourceColumns(controller, id)).source_kind).toBe("url");
      expect(await countSecrets(controller, id)).toBe(1);
    });
  });
});

describe("a Replace and a create of the same plugin server at once", () => {
  it("give one winner and one typed conflict that names the winner", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      const connectionId = await connect();
      const id = await insertUrlServerAt(controller, fake.url, { token: OLD_TOKEN });

      const responses = await Promise.all([
        requestUpdate(controller, id, replaceSource(connectionId)),
        requestCreate(controller, { contributionId: "acme/desk", connectionId }),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const winner = await readRecord(responses.find((response) => response.status === 200)!);
      const loser = await readRefusal(
        responses.find((response) => response.status === 409)!,
        409,
      );
      expect(loser.details).toEqual({ reason: "mcp-server-exists", mcpServerId: winner.id });
      const servers = await runSql(
        controller,
        controller.harness.sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM mcp_servers WHERE contribution_id = 'acme/desk'`,
      );
      expect(servers[0]!.n).toBe(1);
    });
  });
});

describe("Replace of a server that Projects and Sessions list", () => {
  let upstream: FakeUpstream | undefined;

  it(
    "keeps its place in the project's list and the session's list",
    async () => {
      upstream = await startFakeUpstream();
      upstream.hold();
      const held = upstream;
      try {
        await withFleet(
          async (arranged) => {
            const controller = {
              harness: arranged.harness,
              base: arranged.harness.base,
              token: arranged.token,
            };
            const connectionId = await createConnection(
              controller.base,
              controller.token,
              "acme/desk",
              { token: "t0ken" },
            );
            const other = await createServer(controller, {
              connectionId: await insertPastedConnection(
                arranged.harness,
                "acme/desk",
                "t0ken-1234",
                "desk-2",
              ),
              name: "other",
            });
            const id = await insertUrlServerAt(controller, held.url, { name: "remote" });
            const project = (await (
              await createProject(controller, {
                name: "Webshop",
                mcpServerIds: [other.id, id],
              })
            ).json()) as Project;
            const thread = await spawnThreadUnder(
              arranged,
              await createProfile(arranged, "plain", ["session.read"]),
            );
            await Effect.runPromise(
              Effect.orDie(
                withTransaction(
                  arranged.harness.sql,
                  Effect.flatMap(sessionRepository, (sessions) =>
                    sessions.replaceMcpServers(thread.session.id, [id, other.id]),
                  ),
                ).pipe(Effect.provideService(SqlClient.SqlClient, arranged.harness.sql)),
              ),
            );

            await readRecord(await requestUpdate(controller, id, replaceSource(connectionId)));

            expect((await readProject(controller, project.id)).mcpServerIds).toEqual([
              other.id,
              id,
            ]);
            const session = (await (
              await get(controller.base, `/api/v1/sessions/${thread.session.id}`, controller.token)
            ).json()) as Session;
            expect(session.mcpServers).toEqual([
              { mcpServerId: id, name: "remote", leftOut: null },
              { mcpServerId: other.id, name: "other", leftOut: null },
            ]);
          },
          {
            plugins: [buildMcpServerPlugin("acme", { server: buildDeskMcpServer("acme", held) })],
          },
        );
      } finally {
        await held.stop();
      }
    },
    WAIT_DEADLINE_MS * 3 + 10_000,
  );
});
