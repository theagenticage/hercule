/**
 * Tests a session's own list of MCP Servers over HTTP, against a real
 * controller with one runner:
 *
 * - what `session.spawn` starts a Thread with when the call gives no list: the
 *   Project's list, else the setting, else a copy of the calling session's
 *   list, and nothing for an Agent's session;
 * - what a fork starts with: the calling session's list, or the parent's when
 *   the user forks;
 * - the `mcp.manage` check on every write of a list, and the refusals;
 * - `session.update` with `mcpServerIds` on running, exited, archived and
 *   non-Thread sessions.
 *
 * What a start records in `leftOut` is tested in the sessions domain
 * (`service.integration.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { Project, Session } from "@hercule/contract";
import type { Plugin } from "@hercule/plugin-host";
import { withTransaction } from "../db";
import { buildDeskMcpServer, buildMcpServerPlugin } from "../plugins/testing";
import {
  collectPushes,
  expectHeld,
  fetchTicket,
  get,
  onSocket,
  post,
  readErrorBody,
  send,
  waitWithin,
} from "../http/testing";
import {
  WAIT_DEADLINE_MS,
  createProfile,
  findProviderAccountId,
  readProfileNamed,
  readSession,
  spawnSession,
  spawnSessionOrFail,
  spawnThreadUnder,
  type Arranged,
} from "../sessions/testing";
import { endResumable, withFleet } from "../workspaces/testing";
import { createServers, startFakeUpstream, type FakeUpstream, type ServerRef } from "./testing";

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

/** Each test sets up a fleet and several Threads, so it gets more than one wait deadline. */
const TEST_TIMEOUT_MS = WAIT_DEADLINE_MS * 3 + 10_000;

/** Runs `body` against a fleet and three MCP Servers named alpha, bravo and charlie. */
const withServers = (
  body: (arranged: Arranged, servers: readonly [ServerRef, ServerRef, ServerRef]) => Promise<void>,
): Promise<void> =>
  withFleet(
    async (arranged) => {
      const servers = await createServers(
        { harness: arranged.harness, base: arranged.harness.base, token: arranged.token },
        ["alpha", "bravo", "charlie"],
      );
      await body(arranged, servers as unknown as readonly [ServerRef, ServerRef, ServerRef]);
    },
    { plugins: PLUGINS },
  );

/** Returns the ids of the session's list, in list order. */
const listOf = (session: Session): ReadonlyArray<string> =>
  session.mcpServers.map((entry) => entry.mcpServerId);

/** Spawns a Thread with `token`'s caller, which is the user unless a session's token is given. */
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

const createProject = async (
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

/** Creates an Agent on the worker profile and returns its id. */
const createAgent = async (arranged: Arranged): Promise<string> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/agents",
    {
      name: "assessor",
      systemPrompt: "You assess tasks.",
      providerAccountId: findProviderAccountId(arranged, "harnesses/test"),
      permissionProfileId: (await readProfileNamed(arranged, "worker")).id,
    },
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { readonly id: string }).id;
};

describe("session.spawn without mcpServerIds", () => {
  it(
    "starts a Thread the user starts with its Project's list, else the setting, and never mixes the two",
    async () => {
      await withServers(async (arranged, [alpha, bravo, charlie]) => {
        await writeThreadDefault(arranged, [charlie.id]);
        const project = await createProject(arranged, "Webshop", [bravo.id, alpha.id]);

        const inProject = await spawnAsOrFail(arranged, arranged.token, {
          projectId: project.id,
        });
        const withoutProject = await spawnAsOrFail(arranged, arranged.token, {});

        expect(listOf(inProject)).toEqual([bravo.id, alpha.id]);
        expect(listOf(withoutProject)).toEqual([charlie.id]);
        expect(withoutProject.mcpServers.map((entry) => entry.name)).toEqual(["charlie"]);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "starts a Thread a session starts with a copy of the caller's list, whatever the Project and the setting hold",
    async () => {
      await withServers(async (arranged, [alpha, bravo, charlie]) => {
        await writeThreadDefault(arranged, [charlie.id]);
        const project = await createProject(arranged, "Webshop", [charlie.id]);
        const caller = await spawnThreadUnder(
          arranged,
          await createProfile(arranged, "spawner", ["session.spawn", "thread.start"]),
          { mcpServerIds: [alpha.id, bravo.id] },
        );

        const plain = await spawnAsOrFail(arranged, caller.token, {});
        const inProject = await spawnAsOrFail(arranged, caller.token, { projectId: project.id });

        expect(listOf(plain)).toEqual([alpha.id, bravo.id]);
        expect(listOf(inProject)).toEqual([alpha.id, bravo.id]);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "starts an Agent's session with no servers, even when the setting names some",
    async () => {
      await withServers(async (arranged, [alpha]) => {
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
      await withServers(async (arranged, [alpha, bravo, charlie]) => {
        await writeThreadDefault(arranged, [charlie.id]);
        const project = await createProject(arranged, "Webshop", [charlie.id]);

        const given = await spawnAsOrFail(arranged, arranged.token, {
          projectId: project.id,
          mcpServerIds: [bravo.id, alpha.id],
        });
        const empty = await spawnAsOrFail(arranged, arranged.token, {
          projectId: project.id,
          mcpServerIds: [],
        });

        expect(listOf(given)).toEqual([bravo.id, alpha.id]);
        expect(empty.mcpServers).toEqual([]);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "needs mcp.manage beside session.spawn, and starts nothing when it refuses",
    async () => {
      await withServers(async (arranged, [alpha]) => {
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
        expect(listOf(allowed)).toEqual([alpha.id]);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is refused as validation with agentId, and for an id no server has",
    async () => {
      await withServers(async (arranged, [alpha]) => {
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
      await withServers(async (arranged, [alpha, bravo]) => {
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
        expect(listOf((await byUser.json()) as Session)).toEqual([alpha.id]);
        expect(listOf((await bySession.json()) as Session)).toEqual([bravo.id]);
      });
    },
    TEST_TIMEOUT_MS,
  );
});

/** Marks the session archived by the user, as `session.archive` does, and nothing else. */
const archive = (arranged: Arranged, id: string): Promise<unknown> =>
  Effect.runPromise(
    Effect.orDie(
      withTransaction(
        arranged.harness.sql,
        arranged.harness.sql`UPDATE sessions SET archived_at = '2026-09-07T10:00:00.000Z',
                                                 archived_by = 'user'
                             WHERE id = unhex(replace(${id}, '-', ''))`,
      ),
    ),
  );

const updateSession = (arranged: Arranged, id: string, body: unknown, token = arranged.token) =>
  send("PATCH", arranged.harness.base, `/api/v1/sessions/${id}`, { body, token });

describe("session.update with mcpServerIds", () => {
  it(
    "replaces a running Thread's list, leaves its model alone, and announces the session",
    async () => {
      await withServers(async (arranged, [alpha, bravo, charlie]) => {
        const thread = await spawnThreadUnder(
          arranged,
          await createProfile(arranged, "plain", ["session.read"]),
          { mcpServerIds: [alpha.id] },
        );
        const ticket = await fetchTicket(arranged.harness.base, arranged.token);

        await onSocket(arranged.harness.base, (client) =>
          Effect.gen(function* () {
            yield* client.hello({ v: 1, ticket });
            const sessions = yield* collectPushes(client, "session");
            yield* Effect.promise(() => expectHeld(arranged.harness.live, 1, "session"));

            const response = yield* Effect.promise(() =>
              updateSession(arranged, thread.session.id, { mcpServerIds: [charlie.id, bravo.id] }),
            );
            expect(response.status, yield* Effect.promise(() => response.clone().text())).toBe(200);
            const updated = (yield* Effect.promise(() => response.json())) as Session;

            expect(listOf(updated)).toEqual([charlie.id, bravo.id]);
            expect(updated.modelSelection).toEqual(thread.session.modelSelection);
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

        const cleared = await updateSession(arranged, thread.session.id, { mcpServerIds: [] });
        expect(((await cleared.json()) as Session).mcpServers).toEqual([]);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "works on an exited Thread for the list only, and refuses a model change there",
    async () => {
      await withServers(async (arranged, [alpha]) => {
        const thread = await spawnThreadUnder(
          arranged,
          await createProfile(arranged, "plain", ["session.read"]),
        );
        await endResumable(arranged, thread.session);

        const list = await updateSession(arranged, thread.session.id, { mcpServerIds: [alpha.id] });
        const model = await updateSession(arranged, thread.session.id, { model: "clever" });
        const both = await updateSession(arranged, thread.session.id, {
          model: "clever",
          mcpServerIds: [],
        });

        expect(list.status, await list.clone().text()).toBe(200);
        expect(listOf((await list.json()) as Session)).toEqual([alpha.id]);
        expect(model.status).toBe(409);
        expect(both.status).toBe(409);
        // The refused call wrote nothing, so the list is still the first one.
        expect(listOf(await readSession(arranged, thread.session.id))).toEqual([alpha.id]);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is refused on an archived Thread",
    async () => {
      await withServers(async (arranged, [alpha]) => {
        const thread = await spawnThreadUnder(
          arranged,
          await createProfile(arranged, "plain", ["session.read"]),
        );
        await endResumable(arranged, thread.session);
        await archive(arranged, thread.session.id);

        const response = await updateSession(arranged, thread.session.id, {
          mcpServerIds: [alpha.id],
        });

        expect(response.status).toBe(409);
        expect(await readErrorBody(response)).toMatchObject({ code: "invalid_state" });
        expect((await readSession(arranged, thread.session.id)).mcpServers).toEqual([]);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses a non-empty list on an Agent's session, and accepts an empty one",
    async () => {
      await withServers(async (arranged, [alpha]) => {
        const session = await spawnSessionOrFail(arranged, {
          prompt: "assess",
          agentId: await createAgent(arranged),
        });

        const refused = await updateSession(arranged, session.id, { mcpServerIds: [alpha.id] });
        const empty = await updateSession(arranged, session.id, { mcpServerIds: [] });

        expect(refused.status).toBe(400);
        expect((await readErrorBody(refused)).issues).toEqual([["mcpServerIds"]]);
        expect(empty.status, await empty.clone().text()).toBe(200);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "needs mcp.manage beside session.steer, and a call without a list needs only session.steer",
    async () => {
      await withServers(async (arranged, [alpha]) => {
        const plain = await spawnThreadUnder(
          arranged,
          await createProfile(arranged, "steerer", ["session.steer"]),
        );
        const manager = await spawnThreadUnder(
          arranged,
          await createProfile(arranged, "steerer-and-manager", ["session.steer", "mcp.manage"]),
        );

        const refused = await updateSession(
          arranged,
          plain.session.id,
          { mcpServerIds: [alpha.id] },
          plain.token,
        );
        const withoutList = await updateSession(arranged, plain.session.id, {}, plain.token);
        const allowed = await updateSession(
          arranged,
          manager.session.id,
          { mcpServerIds: [alpha.id] },
          manager.token,
        );

        expect(refused.status).toBe(403);
        expect(await readErrorBody(refused)).toMatchObject({ grant: "mcp.manage" });
        expect(withoutList.status, await withoutList.clone().text()).toBe(200);
        expect(allowed.status, await allowed.clone().text()).toBe(200);
        expect(listOf((await allowed.json()) as Session)).toEqual([alpha.id]);
        expect((await readSession(arranged, plain.session.id)).mcpServers).toEqual([]);
      });
    },
    TEST_TIMEOUT_MS,
  );
});
