/**
 * The session actor over a real socket: an agent inside a session calling the
 * public API with the token the controller minted for it.
 *
 * Nothing here is arranged behind the API. A machine is enlisted over the real
 * runner socket, the user spawns a session on a named permission profile, and
 * the token the test then presents is the one the controller put on that
 * session's `sessionStart` frame - the same string the runner would inject into
 * the agent's environment. What is asserted is what the agent gets back: which
 * calls succeed, which are refused and by what name, what the task and the
 * event log say made the change, and when the token stops working.
 */
import { describe, expect, it, vi } from "vitest";
import { Duration, Effect } from "effect";
import type { Session, Task } from "@hercule/contract";
import {
  spawnAgentUnder,
  at,
  readProfileNamed,
  createProfile,
  reportEvent,
  waitForSession,
  spawnSession,
  waitForStartFrames,
  readSessionToken,
  waitUntil,
  WAIT_DEADLINE_MS,
  withAgentFleet as withFleet,
  type Agent,
  type Arranged,
} from "../sessions/testing";
import { del, get, post, send } from "./testing";

/**
 * Three, because the longest case here waits for the fleet to be probed, then
 * for a session to start, and then for it to exit. A wait longer than the
 * timeout never gets to give up, and the failure would name the test rather
 * than the move that never came.
 */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** One refusal, read as the code, the message and the grant it names. */
interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly grant?: string;
}

const parseRefusal = async (response: Response): Promise<Refusal> => {
  const body = (await response.json()) as {
    readonly error: {
      readonly code: string;
      readonly message: string;
      readonly details?: { readonly grant?: string };
    };
  };
  return {
    code: body.error.code,
    message: body.error.message,
    ...(body.error.details?.grant === undefined ? {} : { grant: body.error.details.grant }),
  };
};

/** A worker: the shipped profile with task read, create and update, and no delete. */
const createWorkerAgent = async (arranged: Arranged): Promise<Agent> =>
  spawnAgentUnder(arranged, await readProfileNamed(arranged, "worker"));

const exitSession = async (arranged: Arranged, session: Session): Promise<void> => {
  reportEvent(arranged.wire, 2, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.exited",
    reason: "stopped",
  });
  await waitForSession(arranged, session.id, (one) => one.status === "exited");
};

const createTask = (
  base: string,
  token: string,
  fields: Record<string, unknown>,
): Promise<Response> => post(base, "/api/v1/tasks", { description: "", ...fields }, token);

const readTask = async (base: string, token: string, id: string): Promise<Task> => {
  const response = await get(base, `/api/v1/tasks/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Task;
};

interface EventRow {
  readonly kind: string;
  readonly actor: string | null;
}

const listEventsOfKind = async (
  base: string,
  token: string,
  kind: string,
): Promise<ReadonlyArray<EventRow>> => {
  const response = await get(base, `/api/v1/events?kind=${kind}&limit=100`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<EventRow> }).items;
};

describe("the token the controller mints for a session", () => {
  it("rides on the start frame, and is never the plaintext the session row holds", async () => {
    await withFleet(async (arranged) => {
      const { token } = await createWorkerAgent(arranged);

      // The token works, which is the only proof that the hash the row holds
      // was taken from this string.
      const mine = await get(arranged.harness.base, "/api/v1/tasks", token);
      expect(mine.status, await mine.clone().text()).toBe(200);

      // And the plaintext is nowhere in the row: what is kept is a hash.
      const rows = await Effect.runPromise(
        Effect.orDie(arranged.harness.sql`SELECT * FROM sessions`),
      );
      expect(JSON.stringify(rows)).not.toContain(token);
    });
  });

  it("is replaced by a fresh one when the session is resumed, killing the old one", async () => {
    await withFleet(async (arranged) => {
      const { session, token } = await createWorkerAgent(arranged);
      await exitSession(arranged, session);

      // Input to an exited session with a transcript resumes it in place: the
      // same session id, started again, under a token of its own.
      const resumed = await post(
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/input`,
        { text: "carry on" },
        arranged.token,
      );
      expect(resumed.status, await resumed.clone().text()).toBe(200);

      const frames = await waitForStartFrames(arranged, session.id, 2);
      const next = readSessionToken(frames[1]!);
      expect(next).not.toBe(token);

      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "session.started",
        providerRefs: { nativeSessionId: "native-1" },
      });
      await waitForSession(arranged, session.id, (one) => one.status === "idle");

      const fresh = await get(arranged.harness.base, "/api/v1/tasks", next);
      expect(fresh.status, await fresh.clone().text()).toBe(200);

      const stale = await get(arranged.harness.base, "/api/v1/tasks", token);
      expect(stale.status).toBe(401);
      expect((await parseRefusal(stale)).code).toBe("unauthenticated");
    });
  });
});

describe("what a session token may reach", () => {
  it("creates and updates a task on the worker profile, and is refused the delete by name", async () => {
    await withFleet(async (arranged) => {
      const { token } = await createWorkerAgent(arranged);
      const base = arranged.harness.base;

      const created = await createTask(base, token, { title: "the agent's own task" });
      expect(created.status, await created.clone().text()).toBe(200);
      const task = (await created.json()) as Task;

      const updated = await send("PATCH", base, `/api/v1/tasks/${task.id}`, {
        body: { description: "written by the agent" },
        token,
      });
      expect(updated.status, await updated.clone().text()).toBe(200);
      expect((await updated.json()) as Task).toMatchObject({
        description: "written by the agent",
      });

      const deleted = await del(base, `/api/v1/tasks/${task.id}`, token);
      expect(deleted.status).toBe(403);
      expect(await parseRefusal(deleted)).toMatchObject({
        code: "forbidden",
        grant: "task.delete",
      });

      // Refused, and nothing happened: the task is still there.
      expect((await readTask(base, token, task.id)).id).toBe(task.id);
    });
  });

  it("is refused before the body is decoded, so a malformed one still gets 403", async () => {
    await withFleet(async (arranged) => {
      // A profile that reads tasks and nothing else, so the operation whose
      // body could be malformed is one this session may not reach.
      const reader = await createProfile(arranged, "reader", ["task.read"]);
      const { token } = await spawnAgentUnder(arranged, reader);
      const base = arranged.harness.base;

      const task = (await (
        await createTask(base, arranged.token, { title: "a task" })
      ).json()) as Task;

      const malformed = await send("PATCH", base, `/api/v1/tasks/${task.id}`, {
        body: "{ this is not json",
        token,
      });
      expect(malformed.status).toBe(403);
      expect(await parseRefusal(malformed)).toMatchObject({
        code: "forbidden",
        grant: "task.update",
      });

      // The same body from the user, who holds the grant, is the 400 the
      // refusal above was standing in front of.
      const asUser = await send("PATCH", base, `/api/v1/tasks/${task.id}`, {
        body: "{ this is not json",
        token: arranged.token,
      });
      expect(asUser.status).toBe(400);
    });
  });

  it("answers 401 to a token no session holds", async () => {
    await withFleet(async (arranged) => {
      await createWorkerAgent(arranged);
      const response = await get(
        arranged.harness.base,
        "/api/v1/tasks",
        "a-token-nobody-ever-minted",
      );
      expect(response.status).toBe(401);
      expect((await parseRefusal(response)).code).toBe("unauthenticated");
    });
  });
});

describe("when a session token stops working", () => {
  it("dies with the session the machine reports has exited", async () => {
    await withFleet(async (arranged) => {
      const { session, token } = await createWorkerAgent(arranged);
      expect((await get(arranged.harness.base, "/api/v1/tasks", token)).status).toBe(200);

      await exitSession(arranged, session);

      const after = await get(arranged.harness.base, "/api/v1/tasks", token);
      expect(after.status).toBe(401);
      expect((await parseRefusal(after)).code).toBe("unauthenticated");
    });
  });

  it("dies with the session a retired runner's machine can no longer run", async () => {
    await withFleet(async (arranged) => {
      const { session, token } = await createWorkerAgent(arranged);
      expect((await get(arranged.harness.base, "/api/v1/tasks", token)).status).toBe(200);

      const retired = await post(
        arranged.harness.base,
        `/api/v1/runners/${arranged.runnerId}/retire`,
        { force: true },
        arranged.token,
      );
      expect(retired.status, await retired.clone().text()).toBe(200);
      await waitForSession(arranged, session.id, (one) => one.status === "exited");

      const after = await get(arranged.harness.base, "/api/v1/tasks", token);
      expect(after.status).toBe(401);
      expect((await parseRefusal(after)).code).toBe("unauthenticated");
    });
  });

  it("dies with the session whose machine drops and never comes back", async () => {
    await withFleet(
      async (arranged) => {
        const { session, token } = await createWorkerAgent(arranged);
        expect((await get(arranged.harness.base, "/api/v1/tasks", token)).status).toBe(200);

        arranged.wire.close();
        await waitUntil("marked the runner unreachable", async () => {
          const response = await get(
            arranged.harness.base,
            `/api/v1/runners/${arranged.runnerId}`,
            arranged.token,
          );
          const runner = (await response.json()) as { readonly connectivity: string };
          return runner.connectivity === "unreachable" ? runner : undefined;
        });
        // Still alive before the bound: the machine can be out of reach while
        // the session runs on, and the session still needs its token.
        expect((await get(arranged.harness.base, "/api/v1/tasks", token)).status).toBe(200);

        // The machine stays silent, and nothing has been heard about the
        // session for longer than its absolute timeout: eight hours, the
        // shipped default.
        await Effect.runPromise(
          Effect.orDie(arranged.harness.sql`
            UPDATE sessions SET last_activity_at = '2026-01-01T00:00:00.000Z'
            WHERE id = unhex(replace(${session.id}, '-', ''))
          `),
        );

        await waitForSession(arranged, session.id, (one) => one.status === "exited");
        const after = await get(arranged.harness.base, "/api/v1/tasks", token);
        expect(after.status).toBe(401);
        expect((await parseRefusal(after)).code).toBe("unauthenticated");
      },
      { lostRunnerSweepInterval: Duration.millis(50) },
    );
  });

  it("loses a grant the very next call after the profile is edited", async () => {
    await withFleet(async (arranged) => {
      const profile = await readProfileNamed(arranged, "worker");
      const { token } = await spawnAgentUnder(arranged, profile);
      const base = arranged.harness.base;

      const before = await createTask(base, token, { title: "while the grant is held" });
      expect(before.status, await before.clone().text()).toBe(200);

      const edited = await send("PATCH", base, `/api/v1/profiles/${profile.id}`, {
        body: { grants: ["task.read"] },
        token: arranged.token,
      });
      expect(edited.status, await edited.clone().text()).toBe(200);

      const after = await createTask(base, token, { title: "after the grant is gone" });
      expect(after.status).toBe(403);
      expect(await parseRefusal(after)).toMatchObject({ code: "forbidden", grant: "task.create" });

      // What the profile still grants is still reachable, so the refusal is the
      // edit and not the token having been dropped wholesale.
      expect((await get(base, "/api/v1/tasks", token)).status).toBe(200);
    });
  });
});

describe("a session may not spawn a Thread", () => {
  it("refuses a session actor's spawn by naming session.spawn, and lets the user through", async () => {
    await withFleet(async (arranged) => {
      const { token } = await createWorkerAgent(arranged);

      const refused = await post(
        arranged.harness.base,
        "/api/v1/sessions",
        { prompt: "spawn one for me" },
        token,
      );
      expect(refused.status).toBe(403);
      // The profile does not hold the grant, so the refusal is the static one
      // naming it; the Thread rule of the case below never comes into it.
      expect(await parseRefusal(refused)).toMatchObject({
        code: "forbidden",
        grant: "session.spawn",
      });

      // The same call by the user, which is whose Thread it would be.
      const mine = await spawnSession(arranged, { prompt: "and one of my own" });
      expect(mine.status, await mine.clone().text()).toBe(200);
    });
  });

  it("refuses it even on a profile that holds session.spawn", async () => {
    await withFleet(async (arranged) => {
      // The assistant profile holds `session.spawn`, so the static grant check
      // passes and the refusal has to come from the operation itself.
      const { token } = await spawnAgentUnder(
        arranged,
        await readProfileNamed(arranged, "assistant"),
      );

      const refused = await post(
        arranged.harness.base,
        "/api/v1/sessions",
        { prompt: "spawn one for me" },
        token,
      );
      expect(refused.status).toBe(403);
      // The profile does not hold the grant, so the refusal is the static one
      // naming it; the Thread rule of the case below never comes into it.
      expect(await parseRefusal(refused)).toMatchObject({
        code: "forbidden",
        grant: "session.spawn",
      });
    });
  });
});

describe("a session forking a session", () => {
  it("may fork one on its own profile, and not one bounded by another's grants", async () => {
    await withFleet(async (arranged) => {
      // The assistant profile is the shipped one that holds `session.spawn`,
      // which is what `session.continue` asks for.
      const assistant = await readProfileNamed(arranged, "assistant");
      const mine = await spawnAgentUnder(arranged, assistant);
      const base = arranged.harness.base;

      // Two parents to choose between, each exited with a transcript on a live
      // machine and so forkable: one on this session's own profile, one on a
      // narrower profile that is not its to reach into. Neither is the
      // session doing the asking, whose own token dies when it exits.
      const sibling = await spawnAgentUnder(arranged, assistant);
      const stranger = await createWorkerAgent(arranged);
      await exitSession(arranged, sibling.session);
      await exitSession(arranged, stranger.session);

      const continueSession = (id: string): Promise<Response> =>
        post(
          base,
          `/api/v1/sessions/${id}/continue`,
          { mode: "fork", prompt: "carry this one on for me" },
          mine.token,
        );

      const theirs = await continueSession(stranger.session.id);
      expect(theirs.status).toBe(403);
      const refusal = await parseRefusal(theirs);
      expect(refusal).toMatchObject({ code: "forbidden", grant: "session.spawn" });
      expect(refusal.message.toLowerCase()).toContain("profile");

      const own = await continueSession(sibling.session.id);
      expect(own.status, await own.clone().text()).toBe(200);
      expect((await own.json()) as Session).toMatchObject({
        permissionProfileId: assistant.id,
        parentSessionId: sibling.session.id,
      });
    });
  });
});

describe("what the record says made the change", () => {
  it("stamps a session's task and its event log rows session:<id>, where the user's say user", async () => {
    await withFleet(async (arranged) => {
      const { session, token } = await createWorkerAgent(arranged);
      const base = arranged.harness.base;
      const stamp = `session:${session.id}`;

      const created = await createTask(base, token, {
        title: "the agent's task",
        provenance: [{ ref: "github:issue:owner/repo#42" }],
      });
      expect(created.status, await created.clone().text()).toBe(200);
      const task = (await created.json()) as Task;
      expect(task.provenance.map((entry) => entry.actor)).toEqual([stamp]);

      const updated = await send("PATCH", base, `/api/v1/tasks/${task.id}`, {
        body: { description: "and its edit", provenance: [{ ref: "github:issue:owner/repo#43" }] },
        token,
      });
      expect(updated.status, await updated.clone().text()).toBe(200);
      expect((await readTask(base, token, task.id)).provenance.map((entry) => entry.actor)).toEqual(
        [stamp, stamp],
      );

      // The same two operations by the user, on a task of the user's own.
      const theirs = await createTask(base, arranged.token, {
        title: "the user's task",
        provenance: [{ ref: "github:issue:owner/repo#44" }],
      });
      expect(theirs.status, await theirs.clone().text()).toBe(200);
      const userTask = (await theirs.json()) as Task;
      expect(userTask.provenance.map((entry) => entry.actor)).toEqual(["user"]);

      const createdRows = await listEventsOfKind(base, arranged.token, "task.created");
      expect(createdRows.map((row) => row.actor)).toEqual(expect.arrayContaining([stamp, "user"]));
      const updatedRows = await listEventsOfKind(base, arranged.token, "task.updated");
      expect(updatedRows.map((row) => row.actor)).toEqual([stamp]);
    });
  });
});
