/**
 * Tests the user's default list of MCP Servers for new Threads over HTTP,
 * against a real controller with a test plugin that offers one MCP server.
 * `thread.mcpServerIds` follows the rules of a Project's list, and reading it
 * leaves out a server that was deleted while the stored list is not rewritten.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SettingsState } from "@hercule/contract";
import type { Plugin } from "@hercule/plugin-host";
import { buildDeskMcpServer, buildMcpServerPlugin } from "../plugins/testing";
import { del, get, readErrorBody, send } from "../http/testing";
import { withSetUpController, type SetUpController } from "../workflows/testing";
import {
  createServers,
  runSql,
  startFakeUpstream,
  type FakeUpstream,
} from "../mcp-servers/testing";

let upstream: FakeUpstream;
let PLUGINS: ReadonlyArray<Plugin>;

beforeAll(async () => {
  upstream = await startFakeUpstream();
  // No check of the outside server ends, so every server stays `checking`.
  upstream.hold();
  PLUGINS = [buildMcpServerPlugin("acme", { server: buildDeskMcpServer("acme", upstream) })];
});

afterAll(async () => {
  await upstream.stop();
});

describe("the thread default list", () => {
  const writeDefault = (controller: SetUpController, ids: ReadonlyArray<string>) =>
    send("PATCH", controller.base, "/api/v1/settings", {
      body: { user: { "thread.mcpServerIds": ids } },
      token: controller.token,
    });

  const readDefault = async (
    controller: SetUpController,
  ): Promise<ReadonlyArray<string> | undefined> => {
    const response = await get(controller.base, "/api/v1/settings", controller.token);
    return ((await response.json()) as SettingsState).user["thread.mcpServerIds"];
  };

  it("keeps the order, refuses what a project list refuses, and drops a deleted server when read", async () => {
    await withSetUpController(async (controller) => {
      const [first, second, other] = await createServers(controller, ["desk", "desk", "other"]);

      const clash = await writeDefault(controller, [first!.id, second!.id]);
      expect(clash.status).toBe(400);
      expect((await readErrorBody(clash)).issues).toEqual([["user", "thread.mcpServerIds", "1"]]);
      expect(await readDefault(controller)).toBeUndefined();

      const written = await writeDefault(controller, [other!.id, first!.id]);
      expect(written.status, await written.clone().text()).toBe(200);
      expect(await readDefault(controller)).toEqual([other!.id, first!.id]);

      await del(controller.base, `/api/v1/mcp-servers/${other!.id}`, controller.token);

      expect(await readDefault(controller)).toEqual([first!.id]);
      // The stored list is not rewritten by the delete.
      const stored = await runSql(
        controller,
        controller.harness.sql<{ readonly value: string }>`
          SELECT value FROM user_settings WHERE key = 'thread.mcpServerIds'`,
      );
      expect(JSON.parse(stored[0]!.value)).toEqual([other!.id, first!.id]);
    }, PLUGINS);
  });
});
