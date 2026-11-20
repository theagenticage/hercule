/**
 * Tests the lists of MCP Servers over HTTP, against a real controller with a
 * test plugin that offers one MCP server. The outside server never answers, so
 * no check ends:
 *
 * - `project.create` and `project.update` keep the order of the list, refuse a
 *   list that names an unknown server, one server twice or two servers with
 *   one name, and write nothing when they refuse;
 * - a patch that gives no list leaves the list as it is;
 * - a caller with `project.write` and not `mcp.manage` may change everything
 *   but the list;
 * - `thread.mcpServerIds` follows the same rules, and reading it leaves out a
 *   server that was deleted while the stored list is not rewritten;
 * - deleting a server removes it from every Project's and Session's list and
 *   announces each Session.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import type { Project, Session, SettingsState } from "@hercule/contract";
import type { Plugin } from "@hercule/plugin-host";
import { withTransaction } from "../db";
import { buildDeskMcpServer, buildMcpServerPlugin } from "../plugins/testing";
import {
  collectPushes,
  del,
  expectHeld,
  fetchTicket,
  get,
  onSocket,
  post,
  readErrorBody,
  send,
  waitWithin,
} from "../http/testing";
import { sessionRepository } from "../sessions";
import {
  WAIT_DEADLINE_MS,
  createProfile,
  spawnThreadUnder,
  type Arranged,
} from "../sessions/testing";
import { withFleet } from "../workspaces/testing";
import { withSetUpController, type SetUpController } from "../workflows/testing";
import {
  createServers,
  runSql,
  startFakeUpstream,
  type FakeUpstream,
  type ServerRef,
} from "./testing";

let upstream: FakeUpstream;
let PLUGINS: ReadonlyArray<Plugin>;

beforeAll(async () => {
  upstream = await startFakeUpstream();
  upstream.hold();
  PLUGINS = [buildMcpServerPlugin("acme", { server: buildDeskMcpServer("acme", upstream) })];
});

afterAll(async () => {
  await upstream.stop();
});

const createProject = (
  controller: Pick<SetUpController, "base" | "token">,
  body: unknown,
  token = controller.token,
) => post(controller.base, "/api/v1/projects", body, token);

const updateProject = (
  controller: Pick<SetUpController, "base" | "token">,
  id: string,
  body: unknown,
  token = controller.token,
) => send("PATCH", controller.base, `/api/v1/projects/${id}`, { body, token });

const readProject = async (
  controller: Pick<SetUpController, "base" | "token">,
  id: string,
): Promise<Project> => {
  const response = await get(controller.base, `/api/v1/projects/${id}`, controller.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Project;
};

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

/** Writes a session's list, as the session operations will once they take `mcpServerIds`. */
const writeSessionList = (
  arranged: Arranged,
  sessionId: string,
  servers: ReadonlyArray<ServerRef>,
): Promise<void> =>
  runOnSessions(
    arranged,
    Effect.flatMap(sessionRepository, (sessions) =>
      sessions.replaceMcpServers(
        sessionId,
        servers.map((server) => ({ mcpServerId: server.id, name: server.name })),
      ),
    ),
  );

/** Runs a session repository write in its own transaction. */
const runOnSessions = (
  arranged: Arranged,
  write: Effect.Effect<void, unknown, SqlClient.SqlClient>,
): Promise<void> =>
  Effect.runPromise(
    Effect.orDie(
      withTransaction(arranged.harness.sql, write).pipe(
        Effect.provideService(SqlClient.SqlClient, arranged.harness.sql),
      ),
    ),
  );

const readSessionRecord = async (arranged: Arranged, id: string): Promise<Session> =>
  (await (
    await get(arranged.harness.base, `/api/v1/sessions/${id}`, arranged.token)
  ).json()) as Session;

describe("a session's list", () => {
  it(
    "keeps the reason a start recorded for a server that stays, and starts a new entry unchecked",
    async () => {
      await withFleet(
        async (arranged) => {
          const controller = {
            harness: arranged.harness,
            base: arranged.harness.base,
            token: arranged.token,
          };
          const [a, b, c] = await createServers(controller, ["alpha", "bravo", "charlie"]);
          const thread = await spawnThreadUnder(
            arranged,
            await createProfile(arranged, "plain", ["session.read"]),
          );
          await writeSessionList(arranged, thread.session.id, [a!, b!]);

          await runOnSessions(
            arranged,
            Effect.flatMap(sessionRepository, (sessions) =>
              sessions.recordLeftOut(thread.session.id, new Map([[b!.id, "needs-sign-in"]])),
            ),
          );
          expect((await readSessionRecord(arranged, thread.session.id)).mcpServers).toEqual([
            { mcpServerId: a!.id, name: "alpha", leftOut: null },
            { mcpServerId: b!.id, name: "bravo", leftOut: "needs-sign-in" },
          ]);

          await writeSessionList(arranged, thread.session.id, [c!, b!]);

          expect((await readSessionRecord(arranged, thread.session.id)).mcpServers).toEqual([
            { mcpServerId: c!.id, name: "charlie", leftOut: null },
            { mcpServerId: b!.id, name: "bravo", leftOut: "needs-sign-in" },
          ]);
        },
        { plugins: PLUGINS },
      );
    },
    WAIT_DEADLINE_MS * 3 + 10_000,
  );
});

describe("deleting an MCP Server that lists hold", () => {
  it(
    "removes it from a project's and a session's list, keeps the other entries in order, and announces the session",
    async () => {
      await withFleet(
        async (arranged) => {
          const controller = {
            harness: arranged.harness,
            base: arranged.harness.base,
            token: arranged.token,
          };
          const [a, b, c] = await createServers(controller, ["alpha", "bravo", "charlie"]);
          const project = (await (
            await createProject(controller, {
              name: "Webshop",
              mcpServerIds: [a!.id, b!.id, c!.id],
            })
          ).json()) as Project;
          const thread = await spawnThreadUnder(
            arranged,
            await createProfile(arranged, "plain", ["session.read"]),
          );
          await writeSessionList(arranged, thread.session.id, [a!, b!, c!]);
          const readSession = () => readSessionRecord(arranged, thread.session.id);
          expect((await readSession()).mcpServers).toEqual([
            { mcpServerId: a!.id, name: "alpha", leftOut: null },
            { mcpServerId: b!.id, name: "bravo", leftOut: null },
            { mcpServerId: c!.id, name: "charlie", leftOut: null },
          ]);
          const ticket = await fetchTicket(controller.base, controller.token);

          await onSocket(controller.base, (client) =>
            Effect.gen(function* () {
              yield* client.hello({ v: 1, ticket });
              const sessions = yield* collectPushes(client, "session");
              yield* Effect.promise(() => expectHeld(arranged.harness.live, 1, "session"));

              const deleted = yield* Effect.promise(() =>
                del(controller.base, `/api/v1/mcp-servers/${b!.id}`, controller.token),
              );
              expect(deleted.status).toBe(200);

              expect(
                yield* Effect.promise(() =>
                  waitWithin(1000, () =>
                    sessions.received.some(
                      (push) => push._tag === "invalidate" && push.ids.includes(thread.session.id),
                    ),
                  ),
                ),
              ).toBe(true);
              yield* Fiber.interrupt(sessions.fiber);
            }),
          );

          expect((await readSession()).mcpServers.map((entry) => entry.mcpServerId)).toEqual([
            a!.id,
            c!.id,
          ]);
          expect((await readProject(controller, project.id)).mcpServerIds).toEqual([a!.id, c!.id]);
          // Projects have no live topic, so their change is in the log.
          const updates = await arranged.harness.audit("project.updated");
          expect(updates.at(-1)!.payload).toMatchObject({
            projectId: project.id,
            changes: { mcpServerIds: { old: [a!.id, b!.id, c!.id], new: [a!.id, c!.id] } },
          });
        },
        { plugins: PLUGINS },
      );
    },
    WAIT_DEADLINE_MS * 3 + 10_000,
  );
});
