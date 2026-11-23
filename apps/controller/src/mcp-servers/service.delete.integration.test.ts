/**
 * Tests that deleting an MCP Server removes it from every Project's and every
 * Session's list, over HTTP, against a real controller with a test plugin that
 * offers one MCP server. The outside server never answers, so no check ends.
 * The other entries of each list keep their order, and each Session that held
 * the server is announced.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import type { Project, Session } from "@hercule/contract";
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
import {
  createProject,
  createServers,
  readProject,
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

/** Writes a session's list through the session repository, as `session.update` does. */
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
        servers.map((server) => server.id),
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
