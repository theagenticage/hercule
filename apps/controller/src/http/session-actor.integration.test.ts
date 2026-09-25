/**
 * Tests the session actor over a real socket: an agent inside a session
 * calling the public API with the token the controller minted for it.
 *
 * Nothing is set up behind the API. A runner joins over the real runner
 * socket, the user spawns a session on a named permission profile, and the
 * test then uses the token the controller put on that session's
 * `sessionStart` frame, the same string the runner would put in the agent's
 * environment. The tests check what the agent gets back:
 *
 * - which calls succeed, and which fail and with which grant named;
 * - which actor the task and the event log record for the change;
 * - when the token stops working.
 */
import { describe, expect, it, vi } from "vitest";
import { Duration, Effect } from "effect";
import type { Assistant, Conversation, Session, Task } from "@hercule/contract";
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
 * Three waits, because the longest test waits for the fleet to be probed,
 * then for a session to start, and then for it to exit. If the test timeout
 * were shorter than the waits, a wait would never get to fail, and the error
 * would name the test instead of the step that never happened.
 */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** One error response, read as its code, message and the grant it names. */
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

/** Spawns a worker: the built-in profile with task read, create and update, and no delete. */
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
  it("is sent on the start frame, and the session row never holds it in plain text", async () => {
    await withFleet(async (arranged) => {
      const { token } = await createWorkerAgent(arranged);

      // The token works, which is the only proof that the hash in the row was
      // computed from this string.
      const mine = await get(arranged.harness.base, "/api/v1/tasks", token);
      expect(mine.status, await mine.clone().text()).toBe(200);

      // And the plain text is nowhere in the row: only a hash is kept.
      const rows = await Effect.runPromise(
        Effect.orDie(arranged.harness.sql`SELECT * FROM sessions`),
      );
      expect(JSON.stringify(rows)).not.toContain(token);
    });
  });

  it("is replaced by a new one when the session is resumed, which invalidates the old one", async () => {
    await withFleet(async (arranged) => {
      const { session, token } = await createWorkerAgent(arranged);
      await exitSession(arranged, session);

      // Input to an exited session with a transcript resumes it in place: the
      // same session id, started again, with a new token.
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
  it("creates and updates a task on the worker profile, and is forbidden the delete, with the grant named", async () => {
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

      // Forbidden, and nothing happened: the task is still there.
      expect((await readTask(base, token, task.id)).id).toBe(task.id);
    });
  });

  it("is forbidden before the body is decoded, so a malformed body still gets 403", async () => {
    await withFleet(async (arranged) => {
      // A profile that can only read tasks, so the operation with the
      // malformed body is one this session may not call.
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

      // The same body from the user, who has the grant, gets the 400 that the
      // 403 above came before.
      const asUser = await send("PATCH", base, `/api/v1/tasks/${task.id}`, {
        body: "{ this is not json",
        token: arranged.token,
      });
      expect(asUser.status).toBe(400);
    });
  });

  it("returns 401 for a token that belongs to no session", async () => {
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
  it("stops working when the runner reports that the session exited", async () => {
    await withFleet(async (arranged) => {
      const { session, token } = await createWorkerAgent(arranged);
      expect((await get(arranged.harness.base, "/api/v1/tasks", token)).status).toBe(200);

      await exitSession(arranged, session);

      const after = await get(arranged.harness.base, "/api/v1/tasks", token);
      expect(after.status).toBe(401);
      expect((await parseRefusal(after)).code).toBe("unauthenticated");
    });
  });

  it("stops working when the session's runner is retired", async () => {
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

  it("stops working when the session's runner disconnects and never comes back", async () => {
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
        // Still valid before the timeout: the runner can be unreachable while
        // the session keeps running, and the session still needs its token.
        expect((await get(arranged.harness.base, "/api/v1/tasks", token)).status).toBe(200);

        // The runner stays silent, and nothing has been heard about the
        // session for longer than its absolute timeout: eight hours, the
        // default.
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

  it("loses a grant on the very next call after the profile is edited", async () => {
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

      // What the profile still grants still works, so the 403 is caused by the
      // edit, not by the token having stopped working.
      expect((await get(base, "/api/v1/tasks", token)).status).toBe(200);
    });
  });
});

describe("a session may not spawn a Thread", () => {
  it("forbids a session actor's spawn, naming session.spawn, and allows the user's", async () => {
    await withFleet(async (arranged) => {
      const { token } = await createWorkerAgent(arranged);

      const refused = await post(
        arranged.harness.base,
        "/api/v1/sessions",
        { prompt: "spawn one for me" },
        token,
      );
      expect(refused.status).toBe(403);
      // The profile does not have the grant, so the error comes from the
      // static grant check and names it; the Thread rule tested below is
      // never reached.
      expect(await parseRefusal(refused)).toMatchObject({
        code: "forbidden",
        grant: "session.spawn",
      });

      // The same call by the user, whose Thread it would be, succeeds.
      const mine = await spawnSession(arranged, { prompt: "and one of my own" });
      expect(mine.status, await mine.clone().text()).toBe(200);
    });
  });

  it("forbids it even on a profile that has session.spawn", async () => {
    await withFleet(async (arranged) => {
      // The assistant profile has `session.spawn`, so the static grant check
      // passes, and the error must come from the operation itself.
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
      // The error still names `session.spawn`, but here it comes from the
      // Thread rule in the spawn operation, not from the static grant check.
      expect(await parseRefusal(refused)).toMatchObject({
        code: "forbidden",
        grant: "session.spawn",
      });
    });
  });
});

describe("a session forking a session", () => {
  it("may fork a session on its own profile, but not one on another profile", async () => {
    await withFleet(async (arranged) => {
      // The assistant profile is the built-in one with `session.spawn`, which
      // `session.continue` requires.
      const assistant = await readProfileNamed(arranged, "assistant");
      const mine = await spawnAgentUnder(arranged, assistant);
      const base = arranged.harness.base;

      // Two possible parents, each exited with a transcript on a connected
      // runner, so both can be forked: one on this session's own profile, and
      // one on a narrower profile it may not use. Neither is the calling
      // session, whose token stops working when it exits.
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

describe("which actor a change records", () => {
  it("records session:<id> on a session's task and event log rows, and user on the user's", async () => {
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

      // The same two operations by the user, on the user's own task.
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

describe("a session on the assistant profile", () => {
  /**
   * Returns the default assistant and its web conversation, read with the
   * session's token. Each read fails the test unless it succeeds.
   */
  const readDefaultAssistant = async (
    base: string,
    token: string,
  ): Promise<{ assistant: Assistant; conversation: Conversation }> => {
    const listed = await get(base, "/api/v1/assistants", token);
    expect(listed.status, await listed.clone().text()).toBe(200);
    const [assistant] = ((await listed.json()) as { items: ReadonlyArray<Assistant> }).items;
    expect(assistant, "setup creates the default assistant").toBeDefined();

    const conversations = await get(
      base,
      `/api/v1/conversations?assistantId=${assistant!.id}`,
      token,
    );
    expect(conversations.status, await conversations.clone().text()).toBe(200);
    const [conversation] = ((await conversations.json()) as { items: ReadonlyArray<Conversation> })
      .items;
    expect(conversation, "every assistant has a web conversation").toBeDefined();
    return { assistant: assistant!, conversation: conversation! };
  };

  it("reads assistants and conversations", async () => {
    await withFleet(async (arranged) => {
      const { token } = await spawnAgentUnder(
        arranged,
        await readProfileNamed(arranged, "assistant"),
      );
      const base = arranged.harness.base;
      const { assistant, conversation } = await readDefaultAssistant(base, token);

      const read = await get(base, `/api/v1/assistants/${assistant.id}`, token);
      expect(read.status, await read.clone().text()).toBe(200);
      expect(((await read.json()) as Assistant).id).toBe(assistant.id);

      const readConversation = await get(base, `/api/v1/conversations/${conversation.id}`, token);
      expect(readConversation.status, await readConversation.clone().text()).toBe(200);
      expect(((await readConversation.json()) as Conversation).id).toBe(conversation.id);
    });
  });

  it("reads a conversation's messages", async () => {
    await withFleet(async (arranged) => {
      const { token } = await spawnAgentUnder(
        arranged,
        await readProfileNamed(arranged, "assistant"),
      );
      const base = arranged.harness.base;
      const { conversation } = await readDefaultAssistant(base, token);

      const messages = await get(base, `/api/v1/conversations/${conversation.id}/messages`, token);

      expect(messages.status, await messages.clone().text()).toBe(200);
      expect(await messages.json()).toEqual({ items: [] });
    });
  });

  it("is forbidden to create or update an assistant, and the refusal names agent.write", async () => {
    await withFleet(async (arranged) => {
      const { token } = await spawnAgentUnder(
        arranged,
        await readProfileNamed(arranged, "assistant"),
      );
      const base = arranged.harness.base;
      const { assistant } = await readDefaultAssistant(base, token);

      const created = await post(base, "/api/v1/assistants", { name: "Ada" }, token);
      expect(created.status).toBe(403);
      expect(await parseRefusal(created)).toMatchObject({
        code: "forbidden",
        grant: "agent.write",
      });

      const updated = await send("PATCH", base, `/api/v1/assistants/${assistant.id}`, {
        body: { name: "Bea" },
        token,
      });
      expect(updated.status).toBe(403);
      expect(await parseRefusal(updated)).toMatchObject({
        code: "forbidden",
        grant: "agent.write",
      });
    });
  });
});
