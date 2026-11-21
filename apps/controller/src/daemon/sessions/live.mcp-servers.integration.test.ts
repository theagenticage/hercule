/**
 * Tests `session.update` with `mcpServerIds` over HTTP, against a real
 * controller with one runner: a running Thread's list is replaced and the
 * session announced, an exited Thread takes a list but not a model change, an
 * archived Thread and a non-empty list on an Agent's session are refused, and
 * the call needs `mcp.manage`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { Session } from "@hercule/contract";
import type { Plugin } from "@hercule/plugin-host";
import { withTransaction } from "../../db";
import { buildDeskMcpServer, buildMcpServerPlugin } from "../../plugins/testing";
import {
  collectPushes,
  expectHeld,
  fetchTicket,
  onSocket,
  readErrorBody,
  send,
  waitWithin,
} from "../../http/testing";
import {
  createProfile,
  readSession,
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
      await withServers(PLUGINS, async (arranged, [alpha, bravo, charlie]) => {
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

            expect(listMcpServerIds(updated)).toEqual([charlie.id, bravo.id]);
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

        // Each change of the list is audited with who made it and what it added and removed.
        const entries = await arranged.harness.audit("session.mcpServersChanged");
        expect(entries.map(({ actor, payload }) => ({ actor, payload }))).toEqual([
          {
            actor: "user",
            payload: {
              sessionId: thread.session.id,
              added: [charlie.id, bravo.id],
              removed: [alpha.id],
            },
          },
          {
            actor: "user",
            payload: { sessionId: thread.session.id, added: [], removed: [charlie.id, bravo.id] },
          },
        ]);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "works on an exited Thread for the list only, and refuses a model change there",
    async () => {
      await withServers(PLUGINS, async (arranged, [alpha]) => {
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
        expect(listMcpServerIds((await list.json()) as Session)).toEqual([alpha.id]);
        expect(model.status).toBe(409);
        expect(both.status).toBe(409);
        // The refused call wrote nothing, so the list is still the first one.
        expect(listMcpServerIds(await readSession(arranged, thread.session.id))).toEqual([
          alpha.id,
        ]);
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is refused on an archived Thread",
    async () => {
      await withServers(PLUGINS, async (arranged, [alpha]) => {
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
      await withServers(PLUGINS, async (arranged, [alpha]) => {
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
      await withServers(PLUGINS, async (arranged, [alpha]) => {
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
        expect(listMcpServerIds((await allowed.json()) as Session)).toEqual([alpha.id]);
        expect((await readSession(arranged, plain.session.id)).mcpServers).toEqual([]);
      });
    },
    TEST_TIMEOUT_MS,
  );
});
