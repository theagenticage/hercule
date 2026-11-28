/**
 * Tests the check of an MCP Server over HTTP, against a real controller and a
 * fake outside MCP server that speaks the protocol for real:
 *
 * - a created server lists its tools and becomes `ready`, with the full tool
 *   definitions stored, and a changed list is announced on the live topic;
 * - the MCP revision: a server that speaks only an older one works and the
 *   revision that worked is tried first the next time; a server that speaks
 *   none of the four is `error`;
 * - the credential: a 401 is answered with one refresh and one more try; a
 *   second 401, or a pasted credential, makes the server `error` and leaves
 *   the Connection alone; a provider that refuses the refresh makes the server
 *   `needs-sign-in` and the Connection raises its own Notification; a
 *   provider that cannot be reached is shown in fixed words;
 * - a Connection of another type than the contribution's is never used;
 * - no answer makes the server `unreachable`, and the scheduler follows the
 *   backoff, which Check now ends;
 * - a redirect is not followed, and a URL off the plugin's origin is refused
 *   without any request; a credential a server echoes in a tool definition is
 *   removed before it is stored;
 * - the revision whose handshake worked is stored even when the listing then
 *   fails, and the retry after a refresh starts with it;
 * - a result is dropped when the server, its Connection or its plugin changed
 *   while the check ran, whatever the order of the writes, and a dropped check
 *   of a server that can still be served makes the scheduler check it again;
 * - a check that was superseded never refreshes the Connection;
 * - one Notification per episode of trouble, and none before the server has worked;
 * - the scheduler checks the servers that are due, and nothing leaves the
 *   controller while it is frozen;
 * - a request that comes during a check makes it run once more.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import { McpProtocol } from "effect/ai";
import { buildJsonResponse, readConnection } from "../connections/testing";
import {
  collectPushes,
  fetchTicket,
  onSocket,
  post,
  waitForLiveToSettle,
  waitWithin,
} from "../http/testing";
import { DRAIN_TIMEOUT } from "../promotion";
import type { SetUpController } from "../workflows/testing";
import { McpServerCheckDeadline } from "./checks";
import {
  countNotifications,
  createServer,
  eventually,
  insertOauthConnection,
  readRow,
  readServer,
  refreshedToken,
  requestCheck,
  requestUpdate,
  readRunningWork,
  runSql,
  startFakeUpstream,
  storeOauthTokens,
  waitForResult,
  withRig,
  type McpServerRow,
} from "./testing";

const MINUTE = 60 * 1000;

const LONG_AGO = "2020-01-01T00:00:00.000Z";

/** Returns how many minutes from now the server's next check is planned, rounded. */
const readMinutesToNextCheck = (row: McpServerRow): number =>
  Math.round((Date.parse(row.next_check_at!) - Date.now()) / MINUTE);

/** Makes the server's next check due, as the passing of its wait would. */
const makeCheckDue = (controller: SetUpController) =>
  runSql(controller, controller.harness.sql`UPDATE mcp_servers SET next_check_at = ${LONG_AGO}`);

describe("checking a server", () => {
  it("lists the tools, stores their full definitions and becomes ready", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      const server = await createServer(controller, { connectionId: await connect() });
      expect(server.status).toBe("checking");

      const row = await waitForResult(controller);

      expect(row).toMatchObject({
        status: "ready",
        status_detail: null,
        status_cause: null,
        failed_checks: 0,
        protocol_version: "2026-07-28",
      });
      const stored = JSON.parse(row.tools) as ReadonlyArray<Record<string, unknown>>;
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        name: "echo",
        description: "Echoes its text",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      });
      expect(await readServer(controller, server.id)).toMatchObject({
        status: "ready",
        tools: [{ name: "echo", description: "Echoes its text" }],
        checkedAt: row.checked_at,
      });
      expect(fake.requests.length).toBeGreaterThan(0);
      expect(new Set(fake.requests.map((request) => request.authorization))).toEqual(
        new Set(["Bearer t0ken"]),
      );
      expect(Date.parse(row.next_check_at!) - Date.parse(row.updated_at)).toBe(24 * 60 * MINUTE);
      expect(await countNotifications(controller)).toBe(0);
    });
  });

  it("stores a tool list that differs and announces the server on its live topic", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      const connectionId = await connect();
      const ticket = await fetchTicket(controller.base, controller.token);

      await onSocket(controller.base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const pushes = yield* collectPushes(client, "mcpServer");
          yield* Effect.promise(async () => {
            const server = await createServer(controller, { connectionId });
            const first = await waitForResult(controller);
            await waitForLiveToSettle();
            const announced = pushes.received.length;

            await fake.configure({
              tools: [
                { name: "echo", description: "Echoes its text" },
                { name: "ping", description: "Pings" },
              ],
            });
            expect((await requestCheck(controller, server.id)).status).toBe(200);
            await eventually(
              () => readRow(controller),
              (row) => row.checked_at !== first.checked_at,
            );

            expect(await waitWithin(2000, () => pushes.received.length > announced)).toBe(true);
            expect(pushes.received.at(-1)).toEqual({
              _tag: "invalidate",
              ids: [server.id],
              kind: "updated",
            });
            expect(
              (await readServer(controller, server.id)).tools.map((tool) => tool.name),
            ).toEqual(["echo", "ping"]);
          });
          yield* Fiber.interrupt(pushes.fiber);
        }),
      );
    });
  });

  it.each([
    ["Effect's server", "2025-06-18", McpProtocol.v2025_06_18, false],
    ["a server on the official SDK", "2025-06-18", McpProtocol.v2025_06_18, true],
    ["a server on the official SDK", "2025-03-26", McpProtocol.v2025_03_26, true],
  ])(
    "works with %s that speaks only %s, and tries that revision first next time",
    async (_name, revision, protocol, answersLikeOfficialSdk) => {
      await withRig(
        async ({ controller, fake, connect }) => {
          const server = await createServer(controller, { connectionId: await connect() });
          const first = await waitForResult(controller);
          expect(first).toMatchObject({ status: "ready", protocol_version: revision });
          const before = fake.requests.length;

          await requestCheck(controller, server.id);
          await eventually(
            () => readRow(controller),
            (row) => row.checked_at !== first.checked_at,
          );

          // The first request of the second check already carries the revision that worked.
          expect(fake.requests[before]?.protocolVersion).toBe(revision);
        },
        { fake: { protocols: [protocol], answersLikeOfficialSdk } },
      );
    },
  );

  it("goes to error for a server that speaks none of the revisions", async () => {
    await withRig(
      async ({ controller, connect }) => {
        await createServer(controller, { connectionId: await connect() });

        const row = await waitForResult(controller);

        expect(row).toMatchObject({
          status: "error",
          status_detail: "The server speaks no MCP revision that Hercule can use",
          status_cause: null,
          notified_status: null,
        });
        // The server never worked, so its failure is for whoever adds it to see.
        expect(await countNotifications(controller)).toBe(0);
      },
      { fake: { protocols: [McpProtocol.v2024_11_05] } },
    );
  });

  it("goes to error when the tool list is larger than the size cap", async () => {
    await withRig(
      async ({ controller, connect }) => {
        await createServer(controller, { connectionId: await connect() });

        const row = await waitForResult(controller);

        expect(row.status).toBe("error");
        expect(row.status_detail).toMatch(/larger than 4 MiB/);
      },
      { fake: { tools: [{ name: "big", description: "x".repeat(5 * 1024 * 1024) }] } },
    );
  });

  it("goes to unreachable when the server holds its answer past the deadline of a check", async () => {
    await withRig(
      async ({ controller, fake, connect }) => {
        const release = fake.hold();
        try {
          await createServer(controller, { connectionId: await connect() });

          const row = await waitForResult(controller);

          expect(row).toMatchObject({
            status: "unreachable",
            status_detail: "The server did not answer in time",
          });
        } finally {
          release();
        }
      },
      { checkDeadline: 300 },
    );
  });

  it("ends a check before a freeze gives up waiting for running work", () => {
    const deadline = Effect.runSync(McpServerCheckDeadline);

    expect(Duration.toMillis(deadline)).toBeLessThan(Duration.toMillis(DRAIN_TIMEOUT));
  });
});

describe("the credential of a check", () => {
  it("refreshes the token after a 401, tries once more, and becomes ready", async () => {
    await withRig(
      async ({ controller, fake, provider, connect }) => {
        provider.answers.token = refreshedToken;
        fake.authorize = (authorization) => authorization === "Bearer refreshed-token";
        await createServer(controller, { connectionId: await connect() });

        const row = await waitForResult(controller);

        expect(row.status).toBe("ready");
        const refreshes = provider.tokenRequests.filter(
          (form) => form["grant_type"] === "refresh_token",
        );
        expect(refreshes).toHaveLength(1);
        expect(fake.requests[0]).toMatchObject({
          authorization: "Bearer stored-token",
          status: 401,
        });
        expect(fake.requests.at(-1)?.authorization).toBe("Bearer refreshed-token");
      },
      { oauth: true },
    );
  });

  it("goes to error, and leaves the Connection alone, when the refreshed token is refused too", async () => {
    await withRig(
      async ({ controller, fake, provider, connect }) => {
        provider.answers.token = refreshedToken;
        fake.authorize = () => false;
        const connectionId = await connect();
        await createServer(controller, { connectionId });

        const row = await waitForResult(controller);

        expect(row).toMatchObject({
          status: "error",
          status_detail: "Desk's MCP server refused the Connection's token",
          status_cause: null,
        });
        expect(
          provider.tokenRequests.filter((form) => form["grant_type"] === "refresh_token"),
        ).toHaveLength(1);
        expect((await readConnection(controller.base, controller.token, connectionId)).status).toBe(
          "connected",
        );
      },
      { oauth: true },
    );
  });

  it("goes to needs-sign-in when the provider refuses the refresh, and only the Connection raises a Notification", async () => {
    await withRig(
      async ({ controller, fake, provider, connect }) => {
        provider.answers.token = () =>
          buildJsonResponse(
            { error: "invalid_grant", error_description: "the provider's words" },
            400,
          );
        fake.authorize = () => false;
        const connectionId = await connect();
        await createServer(controller, { connectionId });

        const row = await waitForResult(controller);

        expect(row).toMatchObject({
          status: "needs-sign-in",
          status_detail: "Reconnect work in Settings > Connections",
          status_cause: "connection",
        });
        expect((await readConnection(controller.base, controller.token, connectionId)).status).toBe(
          "needs-reauth",
        );
        expect(await countNotifications(controller, "core.connection-error")).toBe(1);
        expect(await countNotifications(controller)).toBe(0);
      },
      { oauth: true },
    );
  });

  it("goes to unreachable, in fixed words, when the provider cannot be reached for the refresh", async () => {
    await withRig(
      async ({ controller, fake, provider, connect }) => {
        await provider.stop();
        fake.authorize = () => false;
        const connectionId = await connect();
        await createServer(controller, { connectionId });

        const row = await waitForResult(controller);

        expect(row).toMatchObject({
          status: "unreachable",
          status_detail: "Desk could not be reached to refresh the sign-in",
          status_cause: null,
        });
        expect((await readConnection(controller.base, controller.token, connectionId)).status).toBe(
          "connected",
        );
      },
      { oauth: true },
    );
  });

  it("goes to error for a pasted token the server refuses, with nothing to refresh", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      fake.authorize = () => false;
      const connectionId = await connect();
      await createServer(controller, { connectionId });

      const row = await waitForResult(controller);

      expect(row).toMatchObject({
        status: "error",
        status_detail: "Desk's MCP server refused the Connection's token",
      });
      expect((await readConnection(controller.base, controller.token, connectionId)).status).toBe(
        "connected",
      );
    });
  });

  it("goes to error, and leaves the Connection alone, for OAuth tokens that have no refresh token and that the server refuses", async () => {
    await withRig(
      async ({ controller, fake, provider }) => {
        fake.authorize = () => false;
        const connectionId = await insertOauthConnection(controller.harness, {
          accessToken: "stored-token",
        });
        await createServer(controller, { connectionId });

        const row = await waitForResult(controller);

        expect(row).toMatchObject({
          status: "error",
          status_detail: "Desk's MCP server refused the Connection's token",
          status_cause: null,
        });
        expect((await readConnection(controller.base, controller.token, connectionId)).status).toBe(
          "connected",
        );
        expect(await countNotifications(controller, "core.connection-error")).toBe(0);
        expect(provider.tokenRequests).toEqual([]);
      },
      { oauth: true },
    );
  });

  it("keeps the revision that worked when the listing fails, and starts the retry after a refresh with it", async () => {
    await withRig(
      async ({ controller, fake, provider, connect }) => {
        provider.answers.token = refreshedToken;
        fake.authorize = (authorization, method) =>
          method !== "tools/list" || authorization === "Bearer refreshed-token";
        await createServer(controller, { connectionId: await connect() });

        const row = await waitForResult(controller);

        expect(row).toMatchObject({ status: "ready", protocol_version: "2025-06-18" });
        const rejected = fake.requests.findIndex((request) => request.status === 401);
        const retry = fake.requests.slice(rejected + 1).find((one) => one.method === "initialize");
        expect(retry?.protocolVersion).toBe("2025-06-18");
      },
      { oauth: true, fake: { protocols: [McpProtocol.v2025_06_18] } },
    );
  });

  it("stores the revision that worked when the listing fails for good", async () => {
    await withRig(
      async ({ controller, fake, connect }) => {
        fake.authorize = (_authorization, method) => method !== "tools/list";
        await createServer(controller, { connectionId: await connect() });

        const row = await waitForResult(controller);

        expect(row).toMatchObject({ status: "error", protocol_version: "2025-06-18" });
      },
      { fake: { protocols: [McpProtocol.v2025_06_18] } },
    );
  });

  it("never sends a Connection of another type to the server", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      const server = await createServer(controller, { connectionId: await connect() });
      await waitForResult(controller);
      const before = fake.requests.length;
      // A Connection's type never changes through the API, so the test
      // writes the row a plugin that changed its types would leave behind.
      await runSql(controller, controller.harness.sql`UPDATE connections SET type = 'other/desk'`);

      await requestCheck(controller, server.id);
      const row = await eventually(
        () => readRow(controller),
        (found) => found.status === "error",
      );

      expect(row).toMatchObject({
        status_detail: "This server needs a acme/desk Connection, and work is another type",
        status_cause: null,
      });
      expect(fake.requests).toHaveLength(before);
    });
  });
});

describe("a server that cannot be reached", () => {
  it("becomes unreachable, and the scheduler checks it again after 1 minute, 5, 15 and 60, then hourly", async () => {
    await withRig(
      async ({ controller, fake, connect }) => {
        await fake.stop();
        await createServer(controller, { connectionId: await connect() });

        let row = await waitForResult(controller);
        const shownAt = row.updated_at;
        const waits: Array<number> = [];
        for (let attempt = 1; attempt <= 6; attempt++) {
          expect(row).toMatchObject({ status: "unreachable", failed_checks: attempt });
          waits.push(readMinutesToNextCheck(row));
          if (attempt === 6) break;
          await makeCheckDue(controller);
          row = await eventually(
            () => readRow(controller),
            (next) => next.failed_checks === attempt + 1,
          );
        }

        expect(waits).toEqual([1, 5, 15, 60, 60, 60]);
        expect(row.checked_at).toBeNull();
        // A repeat failure changes nothing the record shows.
        expect(row.updated_at).toBe(shownAt);
        // The server never worked, so none of its failures raises a Notification.
        expect(await countNotifications(controller)).toBe(0);
      },
      { checkInterval: 20 },
    );
  });

  it.each([
    [429, "unreachable", 1],
    [503, "unreachable", 1],
    [403, "error", 24 * 60],
  ])(
    "answering every request with HTTP %i makes it %s, and it is checked again in %i minute(s)",
    async (status, expected, minutes) => {
      await withRig(async ({ controller, fake, connect }) => {
        fake.refuseWithStatus = status;
        await createServer(controller, { connectionId: await connect() });

        const row = await waitForResult(controller);

        expect(row.status).toBe(expected);
        expect(readMinutesToNextCheck(row)).toBe(minutes);
      });
    },
  );

  it("is checked again after 1 minute, not the hour it was waiting, when its user asks for a check now", async () => {
    await withRig(
      async ({ controller, fake, connect }) => {
        await fake.stop();
        const server = await createServer(controller, { connectionId: await connect() });
        await waitForResult(controller);
        for (let failed = 1; failed < 3; failed++) {
          await makeCheckDue(controller);
          await eventually(
            () => readRow(controller),
            (next) => next.failed_checks === failed + 1,
          );
        }
        expect(readMinutesToNextCheck(await readRow(controller))).toBe(15);

        await requestCheck(controller, server.id);

        const row = await eventually(
          () => readRow(controller),
          (next) => next.failed_checks === 1,
        );
        expect(readMinutesToNextCheck(row)).toBe(1);
      },
      { checkInterval: 20 },
    );
  });
});

describe("what a check never does", () => {
  it("does not follow a redirect, which would carry the token to another origin", async () => {
    const target = await startFakeUpstream();
    try {
      await withRig(async ({ controller, fake, connect }) => {
        fake.redirectTo = target.url;
        await createServer(controller, { connectionId: await connect() });

        const row = await waitForResult(controller);

        expect(row.status).toBe("error");
        expect(row.status_detail).toBe(
          "The server answered with a redirect (HTTP 302), which is not followed",
        );
        expect(fake.requests).toHaveLength(1);
        expect(target.requests).toEqual([]);
      });
    } finally {
      await target.stop();
    }
  });

  it("stores no credential the server echoes in a tool definition, and leaves out a tool whose name holds one", async () => {
    await withRig(
      async ({ controller, connect }) => {
        await createServer(controller, { connectionId: await connect() });

        const row = await waitForResult(controller);

        expect(row.status).toBe("ready");
        expect(row.tools).not.toContain("t0ken");
        // A rewritten name would be sent back to the server as the name of
        // another tool, so that tool is not stored at all.
        expect(JSON.parse(row.tools)).toMatchObject([
          { name: "plain", description: "sent Bearer [removed] to this tool" },
        ]);
      },
      {
        fake: {
          tools: [
            { name: "Bearer t0ken", description: "named after the credential" },
            { name: "plain", description: "sent Bearer t0ken to this tool" },
          ],
        },
      },
    );
  });

  it("sends nothing when the plugin builds a URL off its origin", async () => {
    const elsewhere = await startFakeUpstream();
    try {
      await withRig(
        async ({ controller, fake, connect }) => {
          await createServer(controller, { connectionId: await connect() });

          const row = await waitForResult(controller);

          expect(row.status).toBe("error");
          expect(row.status_detail).toMatch(/outside its server's origin/);
          expect(fake.requests).toEqual([]);
          expect(elsewhere.requests).toEqual([]);
        },
        { buildUpstreamRequest: () => ({ url: elsewhere.url, headers: {} }) },
      );
    } finally {
      await elsewhere.stop();
    }
  });
});

describe("a result that is out of date", () => {
  it("is dropped when the server was switched off and on while the check ran", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      // The first check is refused with a 401 once its answer arrives, but a
      // later one is let in. Written, the first result would raise a Notification.
      fake.authorize = () => false;
      const release = fake.hold();
      const server = await createServer(controller, { connectionId: await connect() });
      await fake.waitForRequests(1);

      await requestUpdate(controller, server.id, { enabled: false });
      await requestUpdate(controller, server.id, { enabled: true });
      fake.authorize = () => true;
      release();

      await eventually(
        () => readRow(controller),
        (found) => found.status === "ready",
      );
      expect(await countNotifications(controller)).toBe(0);
    });
  });

  it("is dropped when the Connection was reconnected while the check ran, so the old tools are never shown", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      // The old token is let in and the new one refused, so the list the
      // held check ends with is a success the new check cannot repeat: if it
      // were written, the tools would stay in the record next to the error.
      fake.authorize = (authorization) => authorization === "Bearer t0ken";
      const release = fake.hold();
      const connectionId = await connect();
      await createServer(controller, { connectionId });
      await fake.waitForRequests(1);

      const reconnected = await post(
        controller.base,
        `/api/v1/connections/${connectionId}/credentials`,
        { credentials: { token: "new-token" } },
        controller.token,
      );
      expect(reconnected.status, await reconnected.clone().text()).toBe(200);
      await eventually(
        () => readRow(controller),
        (row) => row.connection_generation === 1,
      );
      release();

      const row = await eventually(
        () => readRow(controller),
        (found) => found.status === "error",
      );
      expect(row).toMatchObject({
        status_detail: "Desk's MCP server refused the Connection's token",
        tools: "[]",
        checked_at: null,
      });
      // The server never worked, so this failure raises none.
      expect(await countNotifications(controller)).toBe(0);
    });
  });

  it("sends no further request with the old token once the Connection was reconnected while the check waited for an answer", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      const release = fake.hold();
      const connectionId = await connect();
      await createServer(controller, { connectionId });
      await fake.waitForRequests(1);
      const heldIndex = fake.requests.length;

      const reconnected = await post(
        controller.base,
        `/api/v1/connections/${connectionId}/credentials`,
        { credentials: { token: "new-token" } },
        controller.token,
      );
      expect(reconnected.status, await reconnected.clone().text()).toBe(200);
      release();

      // The check that follows lists the tools with the new token.
      await waitForResult(controller);
      const sent = fake.requests.slice(heldIndex);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.filter((request) => request.authorization === "Bearer t0ken")).toEqual([]);
    });
  });

  it.each([
    ["is switched off", "disabled", "error", "The Connection work is switched off"],
    [
      "needs signing in",
      "needs-reauth",
      "needs-sign-in",
      "Reconnect work in Settings > Connections",
    ],
  ])(
    "is dropped when the Connection %s and nothing has announced it yet, so the old tools are never shown",
    async (_name, connectionStatus, expectedStatus, expectedDetail) => {
      await withRig(
        async ({ controller, fake, connect }) => {
          const release = fake.hold();
          await createServer(controller, { connectionId: await connect() });
          await fake.waitForRequests(1);

          // No operation disables a Connection, and a Connection with pasted
          // credentials has no refresh to refuse. The status is written
          // without an announcement, which is the moment between a Connection's
          // commit and the follower's reaction that the guard exists for.
          await runSql(
            controller,
            controller.harness.sql`UPDATE connections SET status = ${connectionStatus}`,
          );
          release();
          // The scheduler checks again once the held check has ended.
          await makeCheckDue(controller);

          const row = await eventually(
            () => readRow(controller),
            (found) => found.status === expectedStatus,
          );
          expect(row).toMatchObject({
            status_detail: expectedDetail,
            status_cause: "connection",
            tools: "[]",
            checked_at: null,
          });
        },
        { checkInterval: 20 },
      );
    },
  );

  it("is dropped when the Connection's credentials generation moved without any announcement, and the server is checked again at once", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      const release = fake.hold();
      await createServer(controller, { connectionId: await connect() });
      await fake.waitForRequests(1);
      // The loop's own look is a minute away, so a second check can only be
      // the one the dropped check asks for.
      await runSql(
        controller,
        controller.harness
          .sql`UPDATE connections SET credentials_generation = credentials_generation + 1`,
      );
      release();

      // A dropped check of a server that can still be served marks it due.
      // The first check stops before it lists, because the server changed
      // while it waited for the answer, so only the second one lists the tools.
      await waitForResult(controller);
      expect(fake.requests.filter((one) => one.method === "tools/list")).toHaveLength(1);
    });
  });

  it("makes the scheduler check the server again when its Connection moved from connected to error unannounced", async () => {
    await withRig(
      async ({ controller, fake, connect }) => {
        const release = fake.hold();
        await createServer(controller, { connectionId: await connect() });
        await fake.waitForRequests(1);
        // Both statuses are usable, so the follower has no cause to ask for a
        // check, and the server is not due for a day.
        await runSql(controller, controller.harness.sql`UPDATE connections SET status = 'error'`);
        await runSql(
          controller,
          controller.harness.sql`UPDATE mcp_servers SET next_check_at = '2099-01-01T00:00:00.000Z'`,
        );
        release();

        const row = await eventually(
          () => readRow(controller),
          (found) => found.status === "ready",
        );
        expect(row.checked_at).not.toBeNull();
      },
      { checkInterval: 20 },
    );
  });

  it("never refreshes the Connection for a check that was superseded while its tools/list answer was a 401", async () => {
    await withRig(
      async ({ controller, fake, provider, connect }) => {
        provider.answers.token = () => buildJsonResponse({ error: "invalid_grant" }, 400);
        fake.authorize = (_authorization, method) => method !== "tools/list";
        const release = fake.hold("tools/list");
        const connectionId = await connect();
        const server = await createServer(controller, { connectionId });
        await eventually(
          () => Promise.resolve(fake.requests.some((request) => request.method === "tools/list")),
          Boolean,
        );

        await requestUpdate(controller, server.id, { enabled: false });
        release();
        await eventually(
          () =>
            Promise.resolve(
              fake.requests.find((request) => request.method === "tools/list")?.status,
            ),
          (status) => status === 401,
        );
        // Switching the server on requests a check that runs after the held
        // one has ended, so its result is the proof that the held one is done.
        fake.authorize = () => true;
        await requestUpdate(controller, server.id, { enabled: true });
        await eventually(
          () => readRow(controller),
          (found) => found.status === "ready",
        );

        expect(
          provider.tokenRequests.filter((form) => form["grant_type"] === "refresh_token"),
        ).toEqual([]);
        expect((await readConnection(controller.base, controller.token, connectionId)).status).toBe(
          "connected",
        );
        expect(await countNotifications(controller, "core.connection-error")).toBe(0);
      },
      { oauth: true },
    );
  });

  it("never refreshes a stale token for a check that was superseded while it waited for the refresh permit", async () => {
    await withRig(
      async ({ controller, provider, connect }) => {
        const { promotion, mcpServerCalls } = controller.harness;
        const connectionId = await connect();
        const server = await createServer(controller, { connectionId });
        await eventually(
          () => readRow(controller),
          (found) => found.status === "ready",
        );
        await storeOauthTokens(
          controller,
          connectionId,
          { accessToken: "stored-token", refreshToken: "refresh-1" },
          -1000,
        );
        // A call takes the permit, and its request to the provider waits. It
        // fails, so the token is still stale when the permit goes on.
        let letRefreshAnswer: () => void = () => undefined;
        const refreshAnswers = new Promise<void>((resolve) => {
          letRefreshAnswer = resolve;
        });
        provider.answers.token = async () => {
          await refreshAnswers;
          return buildJsonResponse({}, 500);
        };
        const holder = Effect.runPromise(
          Effect.result(
            mcpServerCalls.callTool({
              upstreamScope: "scope",
              serverId: server.id,
              tool: "echo",
              arguments: undefined,
              authorize: Effect.void,
            }),
          ),
        );
        await eventually(
          () => Promise.resolve(provider.tokenRequests.length),
          (count) => count === 1,
        );
        const runningBefore = await readRunningWork(promotion);
        await requestCheck(controller, server.id);
        await eventually(
          () => readRunningWork(promotion),
          (running) => running > runningBefore,
        );
        // The check reads the server and its Connection and then waits for the
        // permit. Nothing shows that it got that far, so give it the time.
        await new Promise((resolve) => setTimeout(resolve, 200));
        await requestUpdate(controller, server.id, { enabled: false });
        letRefreshAnswer();

        await holder;
        await eventually(
          () => readRunningWork(promotion),
          (running) => running === 0,
        );

        expect(provider.tokenRequests).toHaveLength(1);
      },
      { oauth: true },
    );
  });

  it("is dropped, with no Notification, for a server that is switched off", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      fake.authorize = () => false;
      const release = fake.hold();
      const server = await createServer(controller, { connectionId: await connect() });
      await fake.waitForRequests(1);

      await requestUpdate(controller, server.id, { enabled: false });
      release();
      await eventually(
        () => Promise.resolve(fake.requests[0]?.status),
        (status) => status === 401,
      );
      // Switching the server on requests a check that runs after the held one
      // has ended, so its result is the proof that the held one is done.
      fake.authorize = () => true;
      await requestUpdate(controller, server.id, { enabled: true });
      await eventually(
        () => readRow(controller),
        (found) => found.status === "ready",
      );

      expect(await countNotifications(controller)).toBe(0);
    });
  });
});

describe("the Notification of an episode", () => {
  /**
   * Checks the server now and waits until the check ends. Check now marks the
   * next check as due, and the check that ends plans the next one a day later:
   * that is how the end of a check shows.
   */
  const check = async (controller: SetUpController, id: string): Promise<McpServerRow> => {
    await requestCheck(controller, id);
    return eventually(
      () => readRow(controller),
      (next) => Date.parse(next.next_check_at!) - Date.now() > 12 * 60 * MINUTE,
    );
  };

  it("is raised once while the trouble lasts, and again after the server was ready in between", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      // The server works first: only trouble after that is raised.
      const server = await createServer(controller, { connectionId: await connect() });
      let row = await waitForResult(controller);
      expect(row.status).toBe("ready");

      fake.authorize = () => false;
      row = await check(controller, server.id);
      expect(row.status).toBe("error");
      expect(await countNotifications(controller)).toBe(1);

      row = await check(controller, server.id);
      expect(row.status).toBe("error");
      expect(await countNotifications(controller)).toBe(1);

      fake.authorize = () => true;
      row = await check(controller, server.id);
      expect(row).toMatchObject({ status: "ready", notified_status: null });

      fake.authorize = () => false;
      row = await check(controller, server.id);
      expect(row.status).toBe("error");
      expect(await countNotifications(controller)).toBe(2);
    });
  });

  it("is not raised for a server that never worked, and is for its first failure after it did", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      fake.authorize = () => false;
      const server = await createServer(controller, { connectionId: await connect() });
      let row = await waitForResult(controller);
      expect(row).toMatchObject({ status: "error", notified_status: null });

      row = await check(controller, server.id);
      expect(row).toMatchObject({ status: "error", notified_status: null });
      expect(await countNotifications(controller)).toBe(0);

      fake.authorize = () => true;
      row = await check(controller, server.id);
      expect(row.status).toBe("ready");

      fake.authorize = () => false;
      row = await check(controller, server.id);
      expect(row).toMatchObject({ status: "error", notified_status: "error" });
      expect(await countNotifications(controller)).toBe(1);
    });
  });

  it("is raised for a plugin server that worked and then cannot be reached, and not before", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      const server = await createServer(controller, { connectionId: await connect() });
      expect((await waitForResult(controller)).status).toBe("ready");
      await fake.stop();

      await requestCheck(controller, server.id);
      const row = await eventually(
        () => readRow(controller),
        (next) => next.status === "unreachable",
      );

      expect(row.notified_status).toBe("unreachable");
      expect(await countNotifications(controller)).toBe(1);
    });
  });
});

describe("the scheduler", () => {
  it("checks a server whose next check is due", async () => {
    await withRig(
      async ({ controller, fake, connect }) => {
        await createServer(controller, { connectionId: await connect() });
        const first = await waitForResult(controller);
        const before = fake.requests.length;

        await makeCheckDue(controller);

        const row = await eventually(
          () => readRow(controller),
          (next) => next.checked_at !== first.checked_at,
        );
        expect(fake.requests.length).toBeGreaterThan(before);
        expect(Date.parse(row.next_check_at!) - Date.parse(row.updated_at)).toBe(24 * 60 * MINUTE);
      },
      { checkInterval: 20 },
    );
  });

  it("checks a server that has no next check planned, and leaves a switched-off server alone", async () => {
    await withRig(
      async ({ controller, fake, connect }) => {
        const server = await createServer(controller, { connectionId: await connect() });
        const first = await waitForResult(controller);

        await runSql(
          controller,
          controller.harness.sql`UPDATE mcp_servers SET next_check_at = NULL`,
        );
        await eventually(
          () => readRow(controller),
          (next) => next.checked_at !== first.checked_at,
        );

        await requestUpdate(controller, server.id, { enabled: false });
        const before = fake.requests.length;
        await makeCheckDue(controller);
        // Ten looks of the scheduler.
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect(fake.requests).toHaveLength(before);
        expect((await readRow(controller)).next_check_at).toBe(LONG_AGO);
      },
      { checkInterval: 20 },
    );
  });

  it("sends nothing while the controller is frozen, and checks the server when it thaws", async () => {
    await withRig(
      async ({ controller, fake, connect }) => {
        const { promotion } = controller.harness;
        await createServer(controller, { connectionId: await connect() });
        const first = await waitForResult(controller);
        const before = fake.requests.length;
        const token = "0199f0b7-0000-7000-8000-00000000aaaa";
        await Effect.runPromise(promotion.freeze(token, new Date(Date.now() + 60_000)));

        await makeCheckDue(controller);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(fake.requests).toHaveLength(before);

        await Effect.runPromise(promotion.thaw(token));
        await eventually(
          () => readRow(controller),
          (next) => next.checked_at !== first.checked_at,
        );
      },
      { checkInterval: 20 },
    );
  });

  it("makes a freeze wait for the check that is running, which then ends ready and not unreachable", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      const { promotion } = controller.harness;
      const release = fake.hold();
      await createServer(controller, { connectionId: await connect() });
      await fake.waitForRequests(1);

      let frozen = false;
      const freezing = Effect.runPromise(
        promotion.freeze("0199f0b7-0000-7000-8000-00000000aaaa", new Date(Date.now() + 60_000)),
      ).then(() => {
        frozen = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(frozen).toBe(false);

      release();
      await freezing;

      // The freeze ended only after the check wrote its result.
      expect((await readRow(controller)).status).toBe("ready");
    });
  });

  it("runs a check once more when requests came while it was running, however many", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      const release = fake.hold();
      const server = await createServer(controller, { connectionId: await connect() });
      await fake.waitForRequests(1);

      await requestCheck(controller, server.id);
      await requestCheck(controller, server.id);
      release();

      // The check that was running stops before it lists, because each request
      // changed the server. The one check that follows lists the tools once.
      await waitForResult(controller);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fake.requests.filter((one) => one.method === "tools/list")).toHaveLength(1);
    });
  });
});
