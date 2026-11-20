/**
 * Tests the check of an MCP Server over HTTP, against a real controller and a
 * fake outside MCP server that speaks the protocol for real:
 *
 * - a created server lists its tools and becomes `ready`, with the full tool
 *   definitions stored;
 * - the MCP revision: a server that speaks only an older one works and the
 *   revision that worked is tried first the next time; a server that speaks
 *   none of the four is `error`;
 * - the credential: a 401 is answered with one refresh and one more try; a
 *   second 401, or a pasted credential, makes the server `error` and leaves
 *   the Connection alone; a provider that refuses the refresh makes the server
 *   `needs-sign-in`;
 * - no answer makes the server `unreachable` and the next check follows the
 *   backoff;
 * - a redirect is not followed, and a URL off the plugin's origin is refused
 *   without any request;
 * - a result is dropped when the server changed while the check ran;
 * - one Notification per episode of trouble;
 * - the scheduler checks the servers that are due.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect } from "effect";
import { McpProtocol } from "effect/ai";
import type { McpServer } from "@hercule/contract";
import { withTransaction } from "../db";
import { createDeviceProvider, buildJsonResponse, readConnection } from "../connections/testing";
import { get, post, send } from "../http/testing";
import { createConnection, withSetUpController, type SetUpController } from "../workflows/testing";
import {
  buildUpstreamDeskPlugin,
  insertOauthConnection,
  startFakeUpstream,
  type FakeUpstream,
  type FakeUpstreamSettings,
} from "./testing";

const MINUTE = 60 * 1000;

/** The stored fields a test looks at. */
interface Row {
  readonly status: string;
  readonly status_detail: string | null;
  readonly status_cause: string | null;
  readonly tools: string;
  readonly checked_at: string | null;
  readonly protocol_version: string | null;
  readonly revision: number;
  readonly failed_checks: number;
  readonly next_check_at: string | null;
  readonly updated_at: string;
  readonly notified_status: string | null;
}

const runSql = <A>(controller: SetUpController, statement: Effect.Effect<A, unknown>) =>
  Effect.runPromise(Effect.orDie(withTransaction(controller.harness.sql, statement)));

/** Reads the stored row of the only server there is. */
const readRow = async (controller: SetUpController): Promise<Row> => {
  const sql = controller.harness.sql;
  const rows = await runSql(
    controller,
    sql<Row>`SELECT status, status_detail, status_cause, tools, checked_at, protocol_version,
                    revision, failed_checks, next_check_at, updated_at, notified_status
             FROM mcp_servers`,
  );
  return rows[0]!;
};

const countNotifications = async (controller: SetUpController): Promise<number> => {
  const sql = controller.harness.sql;
  const rows = await runSql(
    controller,
    sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM notifications
                                WHERE kind = 'core.mcp-server-failed'`,
  );
  return rows[0]!.n;
};

/** Waits until `read` returns something `done` accepts, polling, and fails the test after ten seconds. */
const eventually = async <A>(read: () => Promise<A>, done: (value: A) => boolean): Promise<A> => {
  const deadline = Date.now() + 10_000;
  let value = await read();
  while (!done(value)) {
    if (Date.now() > deadline)
      throw new Error(`gave up waiting, last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    value = await read();
  }
  return value;
};

const createServer = async (
  controller: SetUpController,
  connectionId: string,
): Promise<McpServer> => {
  const response = await post(
    controller.base,
    "/api/v1/mcp-servers",
    { source: { kind: "plugin", contributionId: "acme/desk", connectionId } },
    controller.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as McpServer;
};

const requestCheck = (controller: SetUpController, id: string) =>
  post(controller.base, `/api/v1/mcp-servers/${id}/check`, {}, controller.token);

const readServer = async (controller: SetUpController, id: string): Promise<McpServer> => {
  const response = await get(controller.base, `/api/v1/mcp-servers/${id}`, controller.token);
  return (await response.json()) as McpServer;
};

/** Waits until the stored status is not `checking`, and returns the row. */
const waitForResult = (controller: SetUpController): Promise<Row> =>
  eventually(
    () => readRow(controller),
    (row) => row.status !== "checking",
  );

interface RigOptions {
  readonly fake?: Partial<FakeUpstreamSettings>;
  readonly oauth?: boolean;
  readonly buildUpstreamRequest?: (credentials: Record<string, string>) => {
    readonly url: string;
    readonly headers: Record<string, string>;
  };
  readonly checkInterval?: number;
}

/**
 * Starts the fake outside server, and a controller with a plugin that offers
 * it. With `oauth`, the Connection holds OAuth tokens and the refresh goes to
 * a fake provider.
 */
const withRig = async (
  body: (rig: {
    readonly controller: SetUpController;
    readonly fake: FakeUpstream;
    readonly provider: ReturnType<typeof createDeviceProvider>;
    /** Makes a Connection of the plugin's type: pasted `t0ken`, or OAuth tokens `stored-token`. */
    readonly connect: () => Promise<string>;
  }) => Promise<void>,
  options: RigOptions = {},
): Promise<void> => {
  const fake = await startFakeUpstream(options.fake);
  const provider = createDeviceProvider();
  try {
    await withSetUpController(
      async (controller) => {
        const connect = () =>
          options.oauth === true
            ? insertOauthConnection(controller.harness, {
                accessToken: "stored-token",
                refreshToken: "refresh-1",
              })
            : createConnection(controller.base, controller.token, "acme/desk", { token: "t0ken" });
        await body({ controller, fake, provider, connect });
      },
      [
        buildUpstreamDeskPlugin(fake, {
          ...(options.oauth === true ? { deviceProviderUrl: provider.base } : {}),
          ...(options.buildUpstreamRequest === undefined
            ? {}
            : { buildUpstreamRequest: options.buildUpstreamRequest }),
        }),
      ],
      options.checkInterval === undefined
        ? {}
        : { mcpServerCheckInterval: Duration.millis(options.checkInterval) },
    );
  } finally {
    await fake.stop();
    await provider.stop();
  }
};

const refreshedToken = () =>
  buildJsonResponse({
    access_token: "refreshed-token",
    refresh_token: "refresh-2",
    token_type: "bearer",
    expires_in: 8 * 60 * 60,
  });

describe("checking a server", () => {
  it("lists the tools, stores their full definitions and becomes ready", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      const server = await createServer(controller, await connect());
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

  it("stores a tool list that differs and announces the server", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      const server = await createServer(controller, await connect());
      const first = await waitForResult(controller);

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

      expect((await readServer(controller, server.id)).tools.map((tool) => tool.name)).toEqual([
        "echo",
        "ping",
      ]);
    });
  });

  it("works with a server that speaks only an older revision, and tries that revision first next time", async () => {
    await withRig(
      async ({ controller, fake, connect }) => {
        const server = await createServer(controller, await connect());
        const first = await waitForResult(controller);
        expect(first).toMatchObject({ status: "ready", protocol_version: "2025-06-18" });
        const before = fake.requests.length;

        await requestCheck(controller, server.id);
        await eventually(
          () => readRow(controller),
          (row) => row.checked_at !== first.checked_at,
        );

        // The first request of the second check already carries the revision that worked.
        expect(fake.requests[before]?.protocolVersion).toBe("2025-06-18");
      },
      { fake: { protocols: [McpProtocol.v2025_06_18] } },
    );
  });

  it("goes to error for a server that speaks none of the revisions", async () => {
    await withRig(
      async ({ controller, connect }) => {
        await createServer(controller, await connect());

        const row = await waitForResult(controller);

        expect(row).toMatchObject({
          status: "error",
          status_detail: "The server speaks no MCP revision that Hercule can use",
          status_cause: null,
          notified_status: "error",
        });
        expect(await countNotifications(controller)).toBe(1);
      },
      { fake: { protocols: [McpProtocol.v2024_11_05] } },
    );
  });

  it("goes to error when the tool list is larger than the size cap", async () => {
    await withRig(
      async ({ controller, connect }) => {
        await createServer(controller, await connect());

        const row = await waitForResult(controller);

        expect(row.status).toBe("error");
        expect(row.status_detail).toMatch(/larger than 4 MiB/);
      },
      { fake: { tools: [{ name: "big", description: "x".repeat(5 * 1024 * 1024) }] } },
    );
  });
});

describe("the credential of a check", () => {
  it("refreshes the token after a 401, tries once more, and becomes ready", async () => {
    await withRig(
      async ({ controller, fake, provider, connect }) => {
        provider.answers.token = refreshedToken;
        fake.authorize = (authorization) => authorization === "Bearer refreshed-token";
        await createServer(controller, await connect());

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
        await createServer(controller, connectionId);

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

  it("goes to needs-sign-in when the provider refuses the refresh", async () => {
    await withRig(
      async ({ controller, fake, provider, connect }) => {
        provider.answers.token = () => buildJsonResponse({ error: "invalid_grant" }, 400);
        fake.authorize = () => false;
        const connectionId = await connect();
        await createServer(controller, connectionId);

        const row = await waitForResult(controller);

        expect(row).toMatchObject({
          status: "needs-sign-in",
          status_detail: "Reconnect work in Settings > Connections",
          status_cause: "connection",
        });
        expect((await readConnection(controller.base, controller.token, connectionId)).status).toBe(
          "needs-reauth",
        );
        // The Connection raises its own Notification.
        expect(await countNotifications(controller)).toBe(0);
      },
      { oauth: true },
    );
  });

  it("goes to error for a pasted token the server refuses, with nothing to refresh", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      fake.authorize = () => false;
      const connectionId = await connect();
      await createServer(controller, connectionId);

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
});

describe("a server that cannot be reached", () => {
  it("becomes unreachable and is checked again after 1 minute, 5, 15 and 60, then hourly", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      await fake.stop();
      const server = await createServer(controller, await connect());

      const waits: Array<number> = [];
      let row = await waitForResult(controller);
      for (let attempt = 1; attempt <= 6; attempt++) {
        expect(row).toMatchObject({ status: "unreachable", failed_checks: attempt });
        waits.push((Date.parse(row.next_check_at!) - Date.parse(row.updated_at)) / MINUTE);
        if (attempt === 6) break;
        const previous = row.updated_at;
        await requestCheck(controller, server.id);
        row = await eventually(
          () => readRow(controller),
          (next) => next.updated_at !== previous,
        );
      }

      expect(waits).toEqual([1, 5, 15, 60, 60, 60]);
      expect(row.checked_at).toBeNull();
      // One Notification for the whole episode.
      expect(await countNotifications(controller)).toBe(1);
    });
  });
});

describe("what a check never does", () => {
  it("does not follow a redirect, which would carry the token to another origin", async () => {
    const target = await startFakeUpstream();
    try {
      await withRig(async ({ controller, fake, connect }) => {
        fake.redirectTo = target.url;
        await createServer(controller, await connect());

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

  it("sends nothing when the plugin builds a URL off its origin", async () => {
    const elsewhere = await startFakeUpstream();
    try {
      await withRig(
        async ({ controller, fake, connect }) => {
          await createServer(controller, await connect());

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
      const server = await createServer(controller, await connect());
      await fake.waitForRequests(1);

      const patch = (enabled: boolean) =>
        send("PATCH", controller.base, `/api/v1/mcp-servers/${server.id}`, {
          body: { enabled },
          token: controller.token,
        });
      await patch(false);
      await patch(true);
      fake.authorize = () => true;
      release();

      const row = await eventually(
        () => readRow(controller),
        (found) => found.status === "ready",
      );
      expect(row.revision).toBe(2);
      expect(await countNotifications(controller)).toBe(0);
    });
  });

  it("is dropped, with no Notification, for a server that is switched off", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      fake.authorize = () => false;
      const release = fake.hold();
      const server = await createServer(controller, await connect());
      await fake.waitForRequests(1);

      await send("PATCH", controller.base, `/api/v1/mcp-servers/${server.id}`, {
        body: { enabled: false },
        token: controller.token,
      });
      release();
      await eventually(
        () => Promise.resolve(fake.requests[0]?.status),
        (status) => status === 401,
      );
      // Switching the server on requests a check that runs after the held one
      // has ended, so its result is the proof that the held one is done.
      fake.authorize = () => true;
      await send("PATCH", controller.base, `/api/v1/mcp-servers/${server.id}`, {
        body: { enabled: true },
        token: controller.token,
      });
      await eventually(
        () => readRow(controller),
        (found) => found.status === "ready",
      );

      expect(await countNotifications(controller)).toBe(0);
    });
  });
});

describe("the Notification of an episode", () => {
  it("is raised once while the trouble lasts, and again after the server was ready in between", async () => {
    await withRig(async ({ controller, fake, connect }) => {
      fake.authorize = () => false;
      const server = await createServer(controller, await connect());
      let row = await waitForResult(controller);
      expect(row.status).toBe("error");
      expect(await countNotifications(controller)).toBe(1);

      const check = async (): Promise<Row> => {
        const previous = (await readRow(controller)).updated_at;
        await requestCheck(controller, server.id);
        return eventually(
          () => readRow(controller),
          (next) => next.updated_at !== previous,
        );
      };

      row = await check();
      expect(row.status).toBe("error");
      expect(await countNotifications(controller)).toBe(1);

      fake.authorize = () => true;
      row = await check();
      expect(row).toMatchObject({ status: "ready", notified_status: null });

      fake.authorize = () => false;
      row = await check();
      expect(row.status).toBe("error");
      expect(await countNotifications(controller)).toBe(2);
    });
  });
});

describe("the scheduler", () => {
  it("checks a server whose next check is due", async () => {
    await withRig(
      async ({ controller, fake, connect }) => {
        await createServer(controller, await connect());
        const first = await waitForResult(controller);
        const before = fake.requests.length;

        await runSql(
          controller,
          controller.harness.sql`UPDATE mcp_servers SET next_check_at = '2020-01-01T00:00:00.000Z'`,
        );

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
});
