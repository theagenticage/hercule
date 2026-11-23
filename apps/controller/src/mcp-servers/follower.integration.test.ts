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
 * - a status the server earned itself is left alone;
 * - a Connection that the step of a run marks `needs-reauth`, on the fiber that
 *   executes the run, reaches the follower like any other change.
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
import { Effect, Redacted, Schema } from "effect";
import { HOST_API, registerWorkflowAction, type Plugin } from "@hercule/plugin-host";
import { OAUTH_TOKENS } from "../connections";
import { buildJsonResponse, createDeviceProvider } from "../connections/testing";
import { serializeTokens } from "../oauth";
import { withTransaction } from "../db";
import { PluginHost } from "../plugins";
import { buildDeskMcpServer, buildMcpServerPlugin } from "../plugins/testing";
import { post, send } from "../http/testing";
import { findStepRecords, startRun, waitForRunToFinish } from "../runs/testing";
import {
  createConnection,
  createWorkflowOrFail,
  disablePlugin,
  withSetUpController,
  type SetUpController,
} from "../workflows/testing";
import {
  countNotifications,
  createServer,
  eventually,
  insertOauthConnection,
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

  it("lists again with the new credentials after a reconnect, and again after a reconnect with the very same credentials", async () => {
    await withReadyServer(async ({ controller, fake, connectionId }) => {
      const reconnect = async (token: string) => {
        const response = await post(
          controller.base,
          `/api/v1/connections/${connectionId}/credentials`,
          { credentials: { token } },
          controller.token,
        );
        expect(response.status, await response.clone().text()).toBe(200);
      };

      await reconnect("new-token");
      await eventually(
        () => Promise.resolve(fake.requests.at(-1)?.authorization),
        (authorization) => authorization === "Bearer new-token",
      );
      await eventually(
        () => readRow(controller),
        (row) => row.status === "ready",
      );
      const requestsBefore = fake.requests.length;

      // A reconnect is a new sign-in even when it stores the same token, so
      // the server is listed again.
      await reconnect("new-token");
      await eventually(
        () => Promise.resolve(fake.requests.length),
        (count) => count > requestsBefore,
      );
      expect(fake.requests.at(-1)?.authorization).toBe("Bearer new-token");
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

/** What `withActionRig` hands a test. */
interface ActionRig {
  readonly controller: SetUpController;
  readonly fake: FakeUpstream;
  readonly provider: ReturnType<typeof createDeviceProvider>;
  readonly connectionId: string;
  /** Makes the Connection's token expire, so the next read of it refreshes it. */
  readonly expireToken: () => Promise<void>;
  /** Runs a workflow whose one step acts through the Connection, and returns how its step ended. */
  readonly runAction: () => Promise<"completed" | "failed">;
}

/**
 * Starts a controller whose plugin offers an MCP server and an action that
 * acts through the same OAuth Connection, so a run reads the Connection's
 * token on the fiber that executes the run, and a refresh is asked for by
 * something other than a check. A server of the Connection is `ready` when
 * `body` starts.
 */
const withActionRig = async (body: (rig: ActionRig) => Promise<void>): Promise<void> => {
  const fake = await startFakeUpstream();
  const provider = createDeviceProvider();
  const mcpPlugin = buildMcpServerPlugin("acme", {
    server: buildDeskMcpServer("acme", fake),
    deviceProviderUrl: provider.base,
  });
  const plugin: Plugin = {
    manifest: {
      id: "acme",
      displayName: "Acme",
      hostApi: HOST_API,
      capabilities: ["connections", "mcp-servers", "workflow-actions"],
      configSchema: Schema.Struct({}),
    },
    register: (host) =>
      Effect.andThen(
        mcpPlugin.register(host),
        registerWorkflowAction(host, {
          id: "desk.touch",
          displayName: "Touch the desk",
          description: "Does nothing, through a Desk Connection.",
          connection: { type: "acme/desk" },
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.succeed({}),
        }),
      ),
    activate: mcpPlugin.activate,
  };
  try {
    await withSetUpController(
      async (controller) => {
        const connectionId = await insertOauthConnection(controller.harness, {
          accessToken: "stored-token",
          refreshToken: "refresh-1",
        });
        await createServer(controller, { connectionId });
        await eventually(
          () => readRow(controller),
          (row) => row.status === "ready",
        );
        const workflow = await createWorkflowOrFail(controller.base, controller.token, {
          definition: {
            name: "Touch the desk",
            steps: [
              {
                id: "touch",
                kind: "action",
                action: "acme/desk.touch",
                params: { connection: connectionId },
              },
            ],
          },
        });
        await body({
          controller,
          fake,
          provider,
          connectionId,
          expireToken: () =>
            Effect.runPromise(
              Effect.asVoid(
                withTransaction(
                  controller.harness.sql,
                  controller.harness.secrets.set(
                    { kind: "connection", id: connectionId },
                    OAUTH_TOKENS,
                    Redacted.make(
                      serializeTokens({
                        accessToken: "stored-token",
                        refreshToken: "refresh-1",
                        expiresAt: new Date(Date.now() - 60_000).toISOString(),
                      }),
                    ),
                  ),
                ),
              ),
            ),
          runAction: async () => {
            const run = await waitForRunToFinish(
              controller.base,
              controller.token,
              await startRun(controller.base, controller.token, workflow.id),
            );
            const step = findStepRecords(run, "touch")[0];
            expect(["completed", "failed"]).toContain(step?.status);
            return step?.status as "completed" | "failed";
          },
        });
      },
      [plugin],
    );
  } finally {
    await fake.stop();
    await provider.stop();
  }
};

describe("a server follows a Connection that a run's step changes", () => {
  it("goes to needs-sign-in when the provider refuses the refresh a workflow's action step asked for", async () => {
    await withActionRig(async ({ controller, provider, expireToken, runAction }) => {
      await expireToken();
      provider.answers.token = () => buildJsonResponse({ error: "invalid_grant" }, 400);

      // The step failed because the refresh was refused, which marks the Connection.
      expect(await runAction()).toBe("failed");

      const stuck = await eventually(
        () => readRow(controller),
        (row) => row.status === "needs-sign-in",
      );
      expect(stuck.status_cause).toBe("connection");
    });
  });

  it("does not list the tools again after the refresh of a token, however the Connection is announced", async () => {
    await withActionRig(
      async ({ controller, fake, provider, connectionId, expireToken, runAction }) => {
        await expireToken();
        provider.answers.token = () =>
          buildJsonResponse({
            access_token: "refreshed-token",
            refresh_token: "refresh-2",
            token_type: "bearer",
            expires_in: 8 * 60 * 60,
          });
        const requestsBefore = fake.requests.length;

        expect(await runAction()).toBe("completed");
        expect(
          provider.tokenRequests.filter((form) => form["grant_type"] === "refresh_token"),
        ).toHaveLength(1);
        await announceConnection(controller, connectionId, "renamed");
        // The follower handles changes in order, so once it has acted on the
        // plugin's change it has seen the Connection's change before it.
        await disablePlugin(controller.base, controller.token, "acme");
        await eventually(
          () => readRow(controller),
          (row) => row.status_cause === "plugin",
        );

        // A refresh is the same sign-in with a new token: nothing is listed again.
        expect(fake.requests).toHaveLength(requestsBefore);
      },
    );
  });
});
