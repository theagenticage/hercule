/**
 * Tests that an MCP Server follows its Connection and its plugin, over HTTP,
 * against a real controller and a fake outside MCP server:
 *
 * - a Connection that needs sign-in moves its servers to `needs-sign-in`, and
 *   a Connection that is usable again clears that and lists the tools again;
 * - a Connection that is switched off moves its servers to `error`;
 * - a reconnect raises the server's revision and lists the tools with the new
 *   credentials;
 * - a plugin that is switched off moves its servers to `error`, and switching
 *   it on lists the tools again;
 * - a status the server earned itself is left alone.
 *
 * No operation can set a Connection to `needs-reauth` or `disabled` without a
 * browser or a provider, so the test writes the status and then changes the
 * Connection's label, which announces the Connection as changed, as every
 * Connection write does.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { McpServer } from "@hercule/contract";
import { withTransaction } from "../db";
import { backdateCredentialsReplacedAt } from "../connections/testing";
import { post, send } from "../http/testing";
import {
  createConnection,
  disablePlugin,
  withSetUpController,
  type SetUpController,
} from "../workflows/testing";
import { buildUpstreamDeskPlugin, startFakeUpstream, type FakeUpstream } from "./testing";

interface Row {
  readonly status: string;
  readonly status_detail: string | null;
  readonly status_cause: string | null;
  readonly revision: number;
  readonly connection_generation: string | null;
}

const runSql = <A>(controller: SetUpController, statement: Effect.Effect<A, unknown>) =>
  Effect.runPromise(Effect.orDie(withTransaction(controller.harness.sql, statement)));

const readRow = async (controller: SetUpController): Promise<Row> => {
  const sql = controller.harness.sql;
  const rows = await runSql(
    controller,
    sql<Row>`SELECT status, status_detail, status_cause, revision, connection_generation
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

/** Starts a controller with a Connection and a server that is `ready`, and runs `body`. */
const withReadyServer = async (
  body: (rig: {
    readonly controller: SetUpController;
    readonly fake: FakeUpstream;
    readonly connectionId: string;
    readonly serverId: string;
  }) => Promise<void>,
): Promise<void> => {
  const fake = await startFakeUpstream();
  try {
    await withSetUpController(
      async (controller) => {
        const connectionId = await createConnection(
          controller.base,
          controller.token,
          "acme/desk",
          {
            token: "t0ken",
          },
        );
        await backdateCredentialsReplacedAt(controller.harness.sql);
        const response = await post(
          controller.base,
          "/api/v1/mcp-servers",
          { source: { kind: "plugin", contributionId: "acme/desk", connectionId } },
          controller.token,
        );
        const server = (await response.json()) as McpServer;
        await eventually(
          () => readRow(controller),
          (row) => row.status === "ready",
        );
        await body({ controller, fake, connectionId, serverId: server.id });
      },
      [buildUpstreamDeskPlugin(fake)],
    );
  } finally {
    await fake.stop();
  }
};

/** Sets the Connection's status in the database, then announces the Connection as changed. */
const changeConnectionStatus = async (
  controller: SetUpController,
  connectionId: string,
  status: "connected" | "needs-reauth" | "disabled",
): Promise<void> => {
  const sql = controller.harness.sql;
  await runSql(controller, sql`UPDATE connections SET status = ${status}`);
  const response = await send("PATCH", controller.base, `/api/v1/connections/${connectionId}`, {
    body: { label: `work-${status}` },
    token: controller.token,
  });
  expect(response.status, await response.clone().text()).toBe(200);
};

describe("a server follows its Connection", () => {
  it("goes to needs-sign-in when the Connection needs sign-in, and lists again when it is usable", async () => {
    await withReadyServer(async ({ controller, fake, connectionId }) => {
      const before = await readRow(controller);
      const requestsBefore = fake.requests.length;

      await changeConnectionStatus(controller, connectionId, "needs-reauth");

      const stuck = await eventually(
        () => readRow(controller),
        (row) => row.status === "needs-sign-in",
      );
      expect(stuck).toMatchObject({
        status_detail: "Reconnect work-needs-reauth in Settings > Connections",
        status_cause: "connection",
      });
      expect(stuck.revision).toBeGreaterThan(before.revision);
      // The Connection raises its own Notification, and nothing was sent.
      expect(await countNotifications(controller)).toBe(0);
      expect(fake.requests).toHaveLength(requestsBefore);

      await changeConnectionStatus(controller, connectionId, "connected");

      const recovered = await eventually(
        () => readRow(controller),
        (row) => row.status === "ready",
      );
      expect(recovered.status_cause).toBeNull();
      expect(fake.requests.length).toBeGreaterThan(requestsBefore);
    });
  });

  it("goes to error when the Connection is switched off", async () => {
    await withReadyServer(async ({ controller, fake, connectionId }) => {
      const requestsBefore = fake.requests.length;

      await changeConnectionStatus(controller, connectionId, "disabled");

      const row = await eventually(
        () => readRow(controller),
        (found) => found.status === "error",
      );
      expect(row).toMatchObject({
        status_detail: "The Connection work-disabled is switched off",
        status_cause: "connection",
      });
      expect(fake.requests).toHaveLength(requestsBefore);
    });
  });

  it("raises the revision and lists again with the new credentials after a reconnect", async () => {
    await withReadyServer(async ({ controller, fake, connectionId }) => {
      const before = await readRow(controller);
      expect(before.connection_generation).not.toBeNull();

      const response = await post(
        controller.base,
        `/api/v1/connections/${connectionId}/credentials`,
        { credentials: { token: "new-token" } },
        controller.token,
      );
      expect(response.status, await response.clone().text()).toBe(200);

      await eventually(
        () => Promise.resolve(fake.requests.at(-1)?.authorization),
        (authorization) => authorization === "Bearer new-token",
      );
      const row = await eventually(
        () => readRow(controller),
        (found) => found.revision > before.revision && found.status === "ready",
      );
      expect(row.connection_generation).not.toBe(before.connection_generation);
    });
  });

  it("leaves a status the server earned itself alone, when the Connection is usable", async () => {
    await withReadyServer(async ({ controller, fake, connectionId, serverId }) => {
      fake.authorize = () => false;
      expect(
        (await post(controller.base, `/api/v1/mcp-servers/${serverId}/check`, {}, controller.token))
          .status,
      ).toBe(200);
      const failed = await eventually(
        () => readRow(controller),
        (row) => row.status === "error",
      );
      const requestsBefore = fake.requests.length;

      const renamed = await send("PATCH", controller.base, `/api/v1/connections/${connectionId}`, {
        body: { label: "renamed" },
        token: controller.token,
      });
      expect(renamed.status).toBe(200);
      // The follower handles changes in order, so once it has acted on the
      // plugin's change it has seen the Connection's change before it. The
      // plugin's change is the only write: one revision, and no new request.
      await disablePlugin(controller.base, controller.token, "acme");
      const row = await eventually(
        () => readRow(controller),
        (found) => found.status_cause === "plugin",
      );

      expect(row.revision).toBe(failed.revision + 1);
      expect(fake.requests).toHaveLength(requestsBefore);
    });
  });
});

describe("a server follows its plugin", () => {
  it("goes to error when the plugin is switched off, and lists again when it is switched on", async () => {
    await withReadyServer(async ({ controller, fake }) => {
      const requestsBefore = fake.requests.length;

      await disablePlugin(controller.base, controller.token, "acme");

      const off = await eventually(
        () => readRow(controller),
        (row) => row.status === "error",
      );
      expect(off).toMatchObject({
        status_detail: "The Acme plugin is switched off",
        status_cause: "plugin",
      });
      expect(fake.requests).toHaveLength(requestsBefore);
      expect(await countNotifications(controller)).toBe(1);

      const response = await post(
        controller.base,
        "/api/v1/plugins/acme/enable",
        {},
        controller.token,
      );
      expect(response.status, await response.clone().text()).toBe(200);

      const on = await eventually(
        () => readRow(controller),
        (row) => row.status === "ready",
      );
      expect(on.status_cause).toBeNull();
      expect(fake.requests.length).toBeGreaterThan(requestsBefore);
    });
  });
});
