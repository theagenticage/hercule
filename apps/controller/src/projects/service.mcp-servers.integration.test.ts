/**
 * Tests the lists of MCP Servers of Projects over HTTP, against a real
 * controller with a test plugin that offers one MCP server. The outside server
 * never answers, so no check ends:
 *
 * - `project.create` and `project.update` keep the order of the list, refuse a
 *   list that names an unknown server, one server twice or two servers with
 *   one name, and write nothing when they refuse;
 * - a patch that gives no list leaves the list as it is;
 * - a caller with `project.write` and not `mcp.manage` may change everything
 *   but the list.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project } from "@hercule/contract";
import type { Plugin } from "@hercule/plugin-host";
import { buildDeskMcpServer, buildMcpServerPlugin } from "../plugins/testing";
import { get, readErrorBody, send } from "../http/testing";
import { WAIT_DEADLINE_MS, createProfile, spawnThreadUnder } from "../sessions/testing";
import { withFleet } from "../workspaces/testing";
import { withSetUpController, type SetUpController } from "../workflows/testing";
import {
  createProject,
  createServers,
  readProject,
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

const updateProject = (
  controller: Pick<SetUpController, "base" | "token">,
  id: string,
  body: unknown,
  token = controller.token,
) => send("PATCH", controller.base, `/api/v1/projects/${id}`, { body, token });

const countProjects = async (
  controller: Pick<SetUpController, "base" | "token">,
): Promise<number> => {
  const response = await get(controller.base, "/api/v1/projects", controller.token);
  return ((await response.json()) as { items: ReadonlyArray<Project> }).items.length;
};

describe("project.create with mcpServerIds", () => {
  it("keeps the list in the order given", async () => {
    await withSetUpController(async (controller) => {
      const [a, b, c] = await createServers(controller, ["alpha", "bravo", "charlie"]);

      const response = await createProject(controller, {
        name: "Webshop",
        mcpServerIds: [c!.id, a!.id, b!.id],
      });

      expect(response.status, await response.clone().text()).toBe(200);
      const created = (await response.json()) as Project;
      expect(created.mcpServerIds).toEqual([c!.id, a!.id, b!.id]);
      expect((await readProject(controller, created.id)).mcpServerIds).toEqual(
        created.mcpServerIds,
      );
      const listed = (await (
        await get(controller.base, "/api/v1/projects", controller.token)
      ).json()) as {
        items: ReadonlyArray<Project>;
      };
      expect(listed.items[0]!.mcpServerIds).toEqual(created.mcpServerIds);
    }, PLUGINS);
  });

  it("starts with an empty list when none is given", async () => {
    await withSetUpController(async (controller) => {
      const response = await createProject(controller, { name: "Webshop" });

      expect(((await response.json()) as Project).mcpServerIds).toEqual([]);
    }, PLUGINS);
  });

  it("refuses an unknown server, a server twice and two servers with one name, and writes nothing", async () => {
    await withSetUpController(async (controller) => {
      const [first, second, other] = await createServers(controller, ["desk", "desk", "other"]);
      const unknown = "0199e0e7-0000-7000-8000-00000000dead";
      const refuse = async (mcpServerIds: ReadonlyArray<string>) => {
        const response = await createProject(controller, { name: "Webshop", mcpServerIds });
        expect(response.status).toBe(400);
        return readErrorBody(response);
      };

      const notFound = await refuse([other!.id, unknown]);
      expect(notFound.code).toBe("validation");
      expect(notFound.issues).toEqual([["mcpServerIds", "1"]]);
      expect(notFound.text).toContain(unknown);

      const twice = await refuse([other!.id, other!.id]);
      expect(twice.issues).toEqual([["mcpServerIds", "1"]]);
      expect(twice.text).toContain("listed twice");

      const sameName = await refuse([first!.id, other!.id, second!.id]);
      expect(sameName.issues).toEqual([["mcpServerIds", "2"]]);
      // The message names both servers.
      expect(sameName.text).toContain(first!.id);
      expect(sameName.text).toContain(second!.id);

      expect(await countProjects(controller)).toBe(0);
    }, PLUGINS);
  });

  it("lets two projects each hold one of two servers that share a name", async () => {
    await withSetUpController(async (controller) => {
      const [first, second] = await createServers(controller, ["desk", "desk"]);

      const one = await createProject(controller, { name: "One", mcpServerIds: [first!.id] });
      const two = await createProject(controller, { name: "Two", mcpServerIds: [second!.id] });

      expect(one.status).toBe(200);
      expect(two.status).toBe(200);
    }, PLUGINS);
  });
});

describe("project.update with mcpServerIds", () => {
  it("leaves the list alone without the field, replaces it with the field, and clears it with an empty list", async () => {
    await withSetUpController(async (controller) => {
      const [a, b, c] = await createServers(controller, ["alpha", "bravo", "charlie"]);
      const created = (await (
        await createProject(controller, { name: "Webshop", mcpServerIds: [a!.id, b!.id] })
      ).json()) as Project;

      const renamed = await updateProject(controller, created.id, { name: "Shop" });
      expect(renamed.status, await renamed.clone().text()).toBe(200);
      expect(((await renamed.json()) as Project).mcpServerIds).toEqual([a!.id, b!.id]);

      const replaced = await updateProject(controller, created.id, {
        mcpServerIds: [c!.id, a!.id],
      });
      expect(replaced.status, await replaced.clone().text()).toBe(200);
      expect(((await replaced.json()) as Project).mcpServerIds).toEqual([c!.id, a!.id]);

      const refused = await updateProject(controller, created.id, { mcpServerIds: [a!.id, a!.id] });
      expect(refused.status).toBe(400);
      expect((await readProject(controller, created.id)).mcpServerIds).toEqual([c!.id, a!.id]);

      const cleared = await updateProject(controller, created.id, { mcpServerIds: [] });
      expect(((await cleared.json()) as Project).mcpServerIds).toEqual([]);
    }, PLUGINS);
  });
});

describe("the mcp.manage check on a list write", () => {
  it(
    "lets a session with project.write change everything but the list, and lets mcp.manage change the list",
    async () => {
      await withFleet(
        async (arranged) => {
          const controller = {
            harness: arranged.harness,
            base: arranged.harness.base,
            token: arranged.token,
          };
          const [server] = await createServers(controller, ["alpha"]);
          const project = (await (
            await createProject(controller, { name: "Webshop" })
          ).json()) as Project;
          const plain = await spawnThreadUnder(
            arranged,
            await createProfile(arranged, "project-writer", ["project.write"]),
          );
          const manager = await spawnThreadUnder(
            arranged,
            await createProfile(arranged, "project-and-mcp-writer", [
              "project.write",
              "mcp.manage",
            ]),
          );

          const refusedCreate = await createProject(
            controller,
            { name: "Docs", mcpServerIds: [server!.id] },
            plain.token,
          );
          expect(refusedCreate.status).toBe(403);
          expect(await readErrorBody(refusedCreate)).toMatchObject({
            code: "forbidden",
            grant: "mcp.manage",
          });
          expect(await countProjects(controller)).toBe(1);

          const withoutList = await createProject(controller, { name: "Docs" }, plain.token);
          expect(withoutList.status, await withoutList.clone().text()).toBe(200);
          const renamed = await updateProject(
            controller,
            project.id,
            { name: "Shop" },
            plain.token,
          );
          expect(renamed.status, await renamed.clone().text()).toBe(200);

          const refusedUpdate = await updateProject(
            controller,
            project.id,
            { name: "Shop again", mcpServerIds: [server!.id] },
            plain.token,
          );
          expect(refusedUpdate.status).toBe(403);
          expect(await readErrorBody(refusedUpdate)).toMatchObject({ grant: "mcp.manage" });
          // The refusal wrote nothing, not even the name beside the list.
          expect(await readProject(controller, project.id)).toMatchObject({
            name: "Shop",
            mcpServerIds: [],
          });

          const allowed = await updateProject(
            controller,
            project.id,
            { mcpServerIds: [server!.id] },
            manager.token,
          );
          expect(allowed.status, await allowed.clone().text()).toBe(200);
          expect(((await allowed.json()) as Project).mcpServerIds).toEqual([server!.id]);
        },
        { plugins: PLUGINS },
      );
    },
    WAIT_DEADLINE_MS * 3 + 10_000,
  );
});
