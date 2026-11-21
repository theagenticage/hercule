/**
 * Tests the MCP Servers a new session starts with, over HTTP, against a real
 * controller with one runner:
 *
 * - what `session.spawn` starts a Thread with when the call gives no list: the
 *   Project's list, else the setting, else a copy of the calling session's
 *   list, and nothing for an Agent's session;
 * - what `session.spawn` does with a list the call gives, and its refusals;
 * - what a fork starts with: the calling session's list, or the parent's when
 *   the user forks.
 *
 * What a start records in `leftOut` is tested in the sessions domain
 * (`service.integration.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project, Session } from "@hercule/contract";
import type { Plugin } from "@hercule/plugin-host";
import { buildDeskMcpServer, buildMcpServerPlugin } from "../../plugins/testing";
import { del, get, post, readErrorBody, send } from "../../http/testing";
import {
  createProfile,
  spawnSession,
  spawnSessionOrFail,
  spawnThreadUnder,
  type Arranged,
} from "../../sessions/testing";
import { endResumable } from "../../workspaces/testing";
import {
  TEST_TIMEOUT_MS,
  createAgent,
  listMcpServerIds,
  startFakeUpstream,
  withServers,
  type FakeUpstream,
} from "../../mcp-servers/testing";

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

const spawnAs = (arranged: Arranged, token: string, body: Record<string, unknown>) =>
  post(arranged.harness.base, "/api/v1/sessions", { prompt: "hello", ...body }, token);

/** Spawns a Thread as the caller and returns the Thread it started, failing the test when refused. */
const spawnAsOrFail = async (
  arranged: Arranged,
  token: string,
  body: Record<string, unknown>,
): Promise<Session> => {
  const response = await spawnAs(arranged, token, body);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Session;
};

const writeThreadDefault = async (arranged: Arranged, ids: ReadonlyArray<string>) => {
  const response = await send("PATCH", arranged.harness.base, "/api/v1/settings", {
    body: { user: { "thread.mcpServerIds": ids } },
    token: arranged.token,
  });
  expect(response.status, await response.clone().text()).toBe(200);
};

const createProjectWithServers = async (
  arranged: Arranged,
  name: string,
  mcpServerIds: ReadonlyArray<string>,
): Promise<Project> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/projects",
    { name, mcpServerIds },
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Project;
};

describe("session.spawn without mcpServerIds", () => {
  it(
    "starts a Thread the user starts with its Project's list, else the setting, and never mixes the two",
    async () => {
      await withServers(PLUGINS, async (arranged, [alpha, bravo, charlie]) => {
        await writeThreadDefault(arranged, [charlie.id]);
        const project = await createProjectWithServers(arranged, "Webshop", [bravo.id, alpha.id]);

        const inProject = await spawnAsOrFail(arranged, arranged.token, {
          projectId: project.id,
        });
        const withoutProject = await spawnAsOrFail(arranged, arranged.token, {});

        expect(listMcpServerIds(inProject)).toEqual([bravo.id, alpha.id]);
        expect(listMcpServerIds(withoutProject)).toEqual([charlie.id]);
        expect(withoutProject.mcpServers.map((entry) => entry.name)).toEqual(["charlie"]);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "starts a Thread a session starts with a copy of the caller's list, whatever the Project and the setting hold",
    async () => {
      await withServers(PLUGINS, async (arranged, [alpha, bravo, charlie]) => {
        await writeThreadDefault(arranged, [charlie.id]);
        const project = await createProjectWithServers(arranged, "Webshop", [charlie.id]);
        const caller = await spawnThreadUnder(
          arranged,
          await createProfile(arranged, "spawner", ["session.spawn", "thread.start"]),
          { mcpServerIds: [alpha.id, bravo.id] },
        );

        const plain = await spawnAsOrFail(arranged, caller.token, {});
        const inProject = await spawnAsOrFail(arranged, caller.token, { projectId: project.id });

        expect(listMcpServerIds(plain)).toEqual([alpha.id, bravo.id]);
        expect(listMcpServerIds(inProject)).toEqual([alpha.id, bravo.id]);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gives a Thread a session starts no servers when the caller's list is empty, and never falls back to the Project or the setting",
    async () => {
      await withServers(PLUGINS, async (arranged, [alpha, bravo]) => {
        await writeThreadDefault(arranged, [bravo.id]);
        const project = await createProjectWithServers(arranged, "Webshop", [alpha.id]);
        const caller = await spawnThreadUnder(
          arranged,
          await createProfile(arranged, "spawner", ["session.spawn", "thread.start"]),
          { mcpServerIds: [] },
        );

        const plain = await spawnAsOrFail(arranged, caller.token, {});
        const inProject = await spawnAsOrFail(arranged, caller.token, { projectId: project.id });

        expect(plain.mcpServers).toEqual([]);
        expect(inProject.mcpServers).toEqual([]);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "starts a Thread with the setting's servers that still exist, after one of them was deleted",
    async () => {
      await withServers(PLUGINS, async (arranged, [alpha, bravo, charlie]) => {
        await writeThreadDefault(arranged, [alpha.id, bravo.id, charlie.id]);
        const deleted = await del(
          arranged.harness.base,
          `/api/v1/mcp-servers/${bravo.id}`,
          arranged.token,
        );
        expect(deleted.status, await deleted.clone().text()).toBe(200);

        const session = await spawnAsOrFail(arranged, arranged.token, {});

        expect(listMcpServerIds(session)).toEqual([alpha.id, charlie.id]);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "starts an Agent's session with no servers, even when the setting names some",
    async () => {
      await withServers(PLUGINS, async (arranged, [alpha]) => {
        await writeThreadDefault(arranged, [alpha.id]);

        const session = await spawnSessionOrFail(arranged, {
          prompt: "assess",
          agentId: await createAgent(arranged),
        });

        expect(session.mcpServers).toEqual([]);
      });
    },
    TEST_TIMEOUT_MS,
  );
});

describe("session.spawn with mcpServerIds", () => {
  it(
    "keeps the list given, in order, and keeps an empty list empty over the Project's list and the setting",
    async () => {
      await withServers(PLUGINS, async (arranged, [alpha, bravo, charlie]) => {
        await writeThreadDefault(arranged, [charlie.id]);
        const project = await createProjectWithServers(arranged, "Webshop", [charlie.id]);

        const given = await spawnAsOrFail(arranged, arranged.token, {
          projectId: project.id,
          mcpServerIds: [bravo.id, alpha.id],
        });
        const empty = await spawnAsOrFail(arranged, arranged.token, {
          projectId: project.id,
          mcpServerIds: [],
        });

        expect(listMcpServerIds(given)).toEqual([bravo.id, alpha.id]);
        expect(empty.mcpServers).toEqual([]);
        // The spawn's own audit entry says which servers the session was given.
        const spawned = await arranged.harness.audit("session.spawned");
        expect(
          spawned.find((entry) => entry.payload["sessionId"] === given.id)?.payload,
        ).toMatchObject({
          mcpServerIds: [bravo.id, alpha.id],
        });
        expect(
          spawned.find((entry) => entry.payload["sessionId"] === empty.id)?.payload,
        ).not.toHaveProperty("mcpServerIds");
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "needs mcp.manage beside session.spawn, and starts nothing when it refuses",
    async () => {
      await withServers(PLUGINS, async (arranged, [alpha]) => {
        const spawnGrants = ["session.spawn", "thread.start", "session.read"] as const;
        const plain = await spawnThreadUnder(
          arranged,
          await createProfile(arranged, "spawner", spawnGrants),
        );
        const manager = await spawnThreadUnder(
          arranged,
          await createProfile(arranged, "spawner-and-manager", [...spawnGrants, "mcp.manage"]),
        );
        const sessionsBefore = await countSessions(arranged);

        const refused = await spawnAs(arranged, plain.token, { mcpServerIds: [alpha.id] });
        const refusedEmpty = await spawnAs(arranged, plain.token, { mcpServerIds: [] });
        const allowed = await spawnAsOrFail(arranged, manager.token, { mcpServerIds: [alpha.id] });

        expect(refused.status).toBe(403);
        expect(await readErrorBody(refused)).toMatchObject({
          code: "forbidden",
          grant: "mcp.manage",
        });
        expect(refusedEmpty.status).toBe(403);
        expect(await countSessions(arranged)).toBe(sessionsBefore + 1);
        expect(listMcpServerIds(allowed)).toEqual([alpha.id]);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is refused as validation with agentId, and for an id no server has",
    async () => {
      await withServers(PLUGINS, async (arranged, [alpha]) => {
        const agentId = await createAgent(arranged);
        const unknown = "0199e0e7-0000-7000-8000-00000000dead";

        const withAgent = await spawnSession(arranged, {
          prompt: "assess",
          agentId,
          mcpServerIds: [alpha.id],
        });
        const withUnknown = await spawnSession(arranged, {
          prompt: "hello",
          mcpServerIds: [alpha.id, unknown],
        });

        expect(withAgent.status).toBe(400);
        expect((await readErrorBody(withAgent)).issues).toEqual([["mcpServerIds"]]);
        expect(withUnknown.status).toBe(400);
        expect((await readErrorBody(withUnknown)).issues).toEqual([["mcpServerIds", "1"]]);
      });
    },
    TEST_TIMEOUT_MS,
  );
});

/** Counts every session of the controller. */
const countSessions = async (arranged: Arranged): Promise<number> => {
  const response = await get(arranged.harness.base, "/api/v1/sessions", arranged.token);
  return ((await response.json()) as { readonly items: ReadonlyArray<Session> }).items.length;
};

describe("session.continue and the MCP servers of a fork", () => {
  it(
    "copies the calling session's list when a session forks, and the parent's when the user forks",
    async () => {
      await withServers(PLUGINS, async (arranged, [alpha, bravo]) => {
        const grants = ["session.spawn", "thread.start"] as const;
        const profile = await createProfile(arranged, "forker", grants);
        const parent = await spawnThreadUnder(arranged, profile, { mcpServerIds: [alpha.id] });
        // The runner's report of the exit lists only the parent, so the parent
        // ends before the caller starts.
        await endResumable(arranged, parent.session);
        const caller = await spawnThreadUnder(arranged, profile, { mcpServerIds: [bravo.id] });

        const byUser = await post(
          arranged.harness.base,
          `/api/v1/sessions/${parent.session.id}/continue`,
          { mode: "fork", prompt: "carry on" },
          arranged.token,
        );
        const bySession = await post(
          arranged.harness.base,
          `/api/v1/sessions/${parent.session.id}/continue`,
          { mode: "fork", prompt: "carry on, as the caller" },
          caller.token,
        );

        expect(byUser.status, await byUser.clone().text()).toBe(200);
        expect(bySession.status, await bySession.clone().text()).toBe(200);
        expect(listMcpServerIds((await byUser.json()) as Session)).toEqual([alpha.id]);
        expect(listMcpServerIds((await bySession.json()) as Session)).toEqual([bravo.id]);
      });
    },
    TEST_TIMEOUT_MS,
  );
});
