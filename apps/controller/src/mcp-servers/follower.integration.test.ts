/**
 * Tests that an MCP Server follows its Connection and its plugin, over HTTP,
 * against a real controller and a fake outside MCP server:
 *
 * - a Connection that needs sign-in moves its servers to `needs-sign-in`, and
 *   reconnecting it clears that and lists the tools again;
 * - a Connection that is switched off moves its servers to `error`;
 * - a reconnect raises the server's revision and lists the tools with the new
 *   credentials;
 * - a plugin that is switched off moves its servers to `error`, and switching
 *   it on lists the tools again;
 * - a plugin that is missing from the build shows the same words whether the
 *   follower or a check says it;
 * - a status the server earned itself is left alone.
 *
 * No operation disables a Connection, and a Connection with pasted
 * credentials has no refresh whose refusal would make it `needs-reauth`. So
 * the test writes that status in the database and then changes the
 * Connection's label, which announces the Connection as changed, as every
 * Connection write does. The way back is a real reconnect. The refusal of a
 * refresh, which makes a Connection `needs-reauth` through the real path, is
 * tested with the checks.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { PluginHost } from "../plugins";
import { buildDeskMcpServer, buildMcpServerPlugin } from "../plugins/testing";
import { post, send } from "../http/testing";
import {
  createConnection,
  disablePlugin,
  withSetUpController,
  type SetUpController,
} from "../workflows/testing";
import {
  countNotifications,
  createServer,
  eventually,
  readRow,
  requestCheck,
  runSql,
  startFakeUpstream,
  type FakeUpstream,
} from "./testing";

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
        const server = await createServer(controller, { connectionId });
        await eventually(
          () => readRow(controller),
          (row) => row.status === "ready",
        );
        await body({ controller, fake, connectionId, serverId: server.id });
      },
      [buildMcpServerPlugin("acme", { server: buildDeskMcpServer("acme", fake) })],
    );
  } finally {
    await fake.stop();
  }
};

/** Renames the Connection, which announces it as changed. */
const announceConnection = async (
  controller: SetUpController,
  connectionId: string,
  label: string,
): Promise<void> => {
  const response = await send("PATCH", controller.base, `/api/v1/connections/${connectionId}`, {
    body: { label },
    token: controller.token,
  });
  expect(response.status, await response.clone().text()).toBe(200);
};

/** Sets the Connection's status in the database, then announces the Connection as changed. */
const changeConnectionStatus = async (
  controller: SetUpController,
  connectionId: string,
  status: "needs-reauth" | "disabled",
): Promise<void> => {
  await runSql(controller, controller.harness.sql`UPDATE connections SET status = ${status}`);
  await announceConnection(controller, connectionId, `work-${status}`);
};

describe("a server follows its Connection", () => {
  it("goes to needs-sign-in when the Connection needs sign-in, and lists again after a reconnect", async () => {
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

      const reconnected = await post(
        controller.base,
        `/api/v1/connections/${connectionId}/credentials`,
        { credentials: { token: "new-token" } },
        controller.token,
      );
      expect(reconnected.status, await reconnected.clone().text()).toBe(200);

      const recovered = await eventually(
        () => readRow(controller),
        (row) => row.status === "ready",
      );
      expect(recovered.status_cause).toBeNull();
      expect(fake.requests.at(-1)?.authorization).toBe("Bearer new-token");
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
      expect(before.connection_generation).toBe(0);

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
      expect(row.connection_generation).toBe(1);
    });
  });

  it("leaves a status the server earned itself alone, when the Connection is usable", async () => {
    await withReadyServer(async ({ controller, fake, connectionId, serverId }) => {
      fake.authorize = () => false;
      expect((await requestCheck(controller, serverId)).status).toBe(200);
      const failed = await eventually(
        () => readRow(controller),
        (row) => row.status === "error",
      );
      const requestsBefore = fake.requests.length;

      await announceConnection(controller, connectionId, "renamed");
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

  it("shows a plugin that is missing from the build in the same words as a check does", async () => {
    await withReadyServer(async ({ controller, fake, connectionId, serverId }) => {
      const requestsBefore = fake.requests.length;
      // The next boot of the plugin host has no plugin that offers the server.
      const rebooted = await controller.harness.runWithLiveSessions(
        Effect.flatMap(PluginHost, (host) => host.boot([])),
      );
      expect(rebooted._tag).toBe("Success");

      await announceConnection(controller, connectionId, "work-after-boot");
      const followed = await eventually(
        () => readRow(controller),
        (row) => row.status === "error",
      );
      expect(followed).toMatchObject({
        status_detail: "The plugin that offered this server is not in this build",
        status_cause: "plugin",
      });

      await requestCheck(controller, serverId);
      // Check now marks the next check as due, and the check that ends plans
      // the next one a day later.
      const checked = await eventually(
        () => readRow(controller),
        (row) => Date.parse(row.next_check_at!) - Date.now() > 12 * 60 * 60 * 1000,
      );
      // The check says the same, so what the record shows does not change.
      expect(checked).toMatchObject({
        status: "error",
        status_detail: followed.status_detail,
        status_cause: "plugin",
        updated_at: followed.updated_at,
      });
      expect(fake.requests).toHaveLength(requestsBefore);
    });
  });
});
