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
import type { Assistant, Conversation, Grant, Profile, Session, Task } from "@hercule/contract";
import {
  spawnThreadUnder,
  spawnThreadWithGrants,
  listSessions,
  findInstanceId,
  spawnSessionOrFail,
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
  type SpawnedThread,
  type Arranged,
} from "../sessions/testing";
import { withPipeline } from "../daemon/testing";
import { withTransaction } from "../db";
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
const spawnWorkerThread = async (arranged: Arranged): Promise<SpawnedThread> =>
  spawnThreadUnder(arranged, await readProfileNamed(arranged, "worker"));

/**
 * Creates an Agent named `name` on `profile`, spawns a session from it as the
 * user, and reports that the session started. Returns the session, which is
 * then `busy`. The runner has reported one event for it, at sequence number 1.
 */
const spawnFromAgent = async (
  arranged: Arranged,
  name: string,
  profile: Profile,
): Promise<Session> => {
  const created = await post(
    arranged.harness.base,
    "/api/v1/agents",
    {
      name,
      systemPrompt: "You carry work on.",
      instanceId: findInstanceId(arranged, "harnesses/full"),
      permissionProfileId: profile.id,
    },
    arranged.token,
  );
  expect(created.status, await created.clone().text()).toBe(200);
  const agent = (await created.json()) as { readonly id: string };
  const opened = await spawnSessionOrFail(arranged, { agentId: agent.id, prompt: "hello" });
  await waitForStartFrames(arranged, opened.id, 1);
  reportEvent(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: opened.id,
    at,
    _tag: "session.started",
    harnessRefs: { nativeSessionId: "native-1" },
  });
  return waitForSession(arranged, opened.id, (one) => one.status === "busy");
};

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
      const { token } = await spawnWorkerThread(arranged);

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
      const { session, token } = await spawnWorkerThread(arranged);
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
        harnessRefs: { nativeSessionId: "native-1" },
      });
      await waitForSession(arranged, session.id, (one) => one.status === "busy");

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
      const { token } = await spawnWorkerThread(arranged);
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
      const { token } = await spawnThreadUnder(arranged, reader);
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
      await spawnWorkerThread(arranged);
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
      const { session, token } = await spawnWorkerThread(arranged);
      expect((await get(arranged.harness.base, "/api/v1/tasks", token)).status).toBe(200);

      await exitSession(arranged, session);

      const after = await get(arranged.harness.base, "/api/v1/tasks", token);
      expect(after.status).toBe(401);
      expect((await parseRefusal(after)).code).toBe("unauthenticated");
    });
  });

  it("stops working when the session's runner is retired", async () => {
    await withFleet(async (arranged) => {
      const { session, token } = await spawnWorkerThread(arranged);
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
        const { session, token } = await spawnWorkerThread(arranged);
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
          Effect.orDie(
            withTransaction(
              arranged.harness.sql,
              arranged.harness.sql`
                UPDATE sessions SET last_activity_at = '2026-01-01T00:00:00.000Z'
                WHERE id = unhex(replace(${session.id}, '-', ''))
              `,
            ),
          ),
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
      const { token } = await spawnThreadUnder(arranged, profile);
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

/** Spawns as the session holding `token`, with `fields` beside a prompt. */
const spawnAs = (arranged: Arranged, token: string, fields: Record<string, unknown> = {}) =>
  post(arranged.harness.base, "/api/v1/sessions", { prompt: "a job for you", ...fields }, token);

/** Creates a project as the user and returns its id. */
const createProject = async (arranged: Arranged, name: string): Promise<string> => {
  const response = await post(arranged.harness.base, "/api/v1/projects", { name }, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { readonly id: string }).id;
};

/** The grants of a profile whose sessions may start and fork a Thread. */
const THREAD_STARTER_GRANTS: ReadonlyArray<Grant> = [
  "session.spawn",
  "session.read",
  "thread.start",
];

describe("a session starting a Thread", () => {
  it("is forbidden without session.spawn, naming session.spawn, while the user may", async () => {
    await withFleet(async (arranged) => {
      const { token } = await spawnWorkerThread(arranged);

      const refused = await spawnAs(arranged, token);

      expect(refused.status).toBe(403);
      expect(await parseRefusal(refused)).toMatchObject({
        code: "forbidden",
        grant: "session.spawn",
      });

      // The same call by the user, whose Thread it would be, succeeds.
      const mine = await spawnSession(arranged, { prompt: "and one of my own" });
      expect(mine.status, await mine.clone().text()).toBe(200);
    });
  });

  it("is forbidden on a profile with session.spawn but without thread.start, naming thread.start", async () => {
    await withFleet(async (arranged) => {
      // The assistant profile has `session.spawn`, so the static grant check
      // passes and the Thread rule in the spawn operation is what refuses.
      const { token } = await spawnThreadUnder(
        arranged,
        await readProfileNamed(arranged, "assistant"),
      );

      const refused = await spawnAs(arranged, token);

      expect(refused.status).toBe(403);
      const refusal = await parseRefusal(refused);
      expect(refusal).toMatchObject({ code: "forbidden", grant: "thread.start" });
      // The message teaches both ways out.
      expect(refusal.message).toContain("Permission Request");
      expect(refusal.message).toContain("agentId");
      expect(await listSessions(arranged)).toHaveLength(1);
    });
  });

  it("ships thread.start on the unrestricted profile only", async () => {
    await withFleet(async (arranged) => {
      const unrestricted = await readProfileNamed(arranged, "unrestricted");
      const assistant = await readProfileNamed(arranged, "assistant");
      const worker = await readProfileNamed(arranged, "worker");

      expect(unrestricted.grants).toContain("thread.start");
      expect(assistant.grants).not.toContain("thread.start");
      expect(worker.grants).not.toContain("thread.start");
    });
  });

  it("copies the calling session's profile, access mode, instance and project when the call has only a prompt", async () => {
    await withFleet(async (arranged) => {
      // A profile that is not the user's default Thread profile, an access mode
      // that is not the default one, and a project, so that a copy cannot be
      // mistaken for a default.
      const profile = await createProfile(arranged, "thread-starter", THREAD_STARTER_GRANTS);
      const projectId = await createProject(arranged, "Bun upgrade");
      const caller = await spawnThreadUnder(arranged, profile, {
        accessMode: "auto-accept-edits",
        projectId,
      });

      const response = await spawnAs(arranged, caller.token);

      expect(response.status, await response.clone().text()).toBe(200);
      expect((await response.json()) as Session).toMatchObject({
        agentId: null,
        permissionProfileId: profile.id,
        requestedAccessMode: "auto-accept-edits",
        instanceId: caller.session.instanceId,
        projectId,
      });
    });
  });

  it("may ask for full-access while running approval-required", async () => {
    await withFleet(async (arranged) => {
      const profile = await createProfile(arranged, "thread-starter", THREAD_STARTER_GRANTS);
      const caller = await spawnThreadUnder(arranged, profile, { accessMode: "approval-required" });

      const response = await spawnAs(arranged, caller.token, { accessMode: "full-access" });

      expect(response.status, await response.clone().text()).toBe(200);
      expect(((await response.json()) as Session).requestedAccessMode).toBe("full-access");
    });
  });

  it("may name a profile no wider than its own, and is forbidden a wider one", async () => {
    await withFleet(async (arranged) => {
      const own = await createProfile(arranged, "own", [...THREAD_STARTER_GRANTS, "task.read"]);
      const narrower = await createProfile(arranged, "narrower", ["session.spawn", "task.read"]);
      const wider = await createProfile(arranged, "wider", [
        ...THREAD_STARTER_GRANTS,
        "task.read",
        "task.create",
      ]);
      const caller = await spawnThreadUnder(arranged, own);

      const refused = await spawnAs(arranged, caller.token, { permissionProfileId: wider.id });
      expect(refused.status).toBe(403);
      expect(await parseRefusal(refused)).toMatchObject({
        code: "forbidden",
        grant: "thread.start",
      });
      expect(await listSessions(arranged)).toHaveLength(1);

      const allowed = await spawnAs(arranged, caller.token, { permissionProfileId: narrower.id });
      expect(allowed.status, await allowed.clone().text()).toBe(200);
      expect(((await allowed.json()) as Session).permissionProfileId).toBe(narrower.id);
    });
  });

  it("is stamped as the calling session, on the first input and in the audit entry", async () => {
    await withFleet(async (arranged) => {
      const caller = await spawnThreadWithGrants(arranged, "thread-starter", THREAD_STARTER_GRANTS);

      const response = await spawnAs(arranged, caller.token);

      expect(response.status, await response.clone().text()).toBe(200);
      const child = (await response.json()) as Session;
      const [start] = await waitForStartFrames(arranged, child.id, 1);
      expect(start!.input.senderSessionId).toBe(caller.session.id);
      const entries = await arranged.harness.audit("session.spawned");
      const entry = entries.find((one) => one.payload?.["sessionId"] === child.id);
      expect(entry?.actor).toBe(`session:${caller.session.id}`);
    });
  });

  it("is allowed by a thread.start decided for the session, which does not widen the profiles it may name", async () => {
    // The pipeline is needed for the Permission Request's subscription.
    await withPipeline(async (arranged) => {
      const own = await createProfile(arranged, "spawner", ["session.spawn", "session.read"]);
      const withThreadStart = await createProfile(arranged, "spawner-with-thread-start", [
        "session.spawn",
        "session.read",
        "thread.start",
      ]);
      const caller = await spawnThreadUnder(arranged, own);
      expect((await spawnAs(arranged, caller.token)).status).toBe(403);

      const asked = await post(
        arranged.harness.base,
        "/api/v1/permissions/request",
        { grant: "thread.start", reason: "The user asked me to start a Thread." },
        caller.token,
      );
      expect(asked.status, await asked.clone().text()).toBe(200);
      const { requestId } = (await asked.json()) as { readonly requestId: string };
      const decided = await post(
        arranged.harness.base,
        `/api/v1/permissions/requests/${requestId}/decide`,
        { outcome: "session" },
        arranged.token,
      );
      expect(decided.status, await decided.clone().text()).toBe(200);

      const started = await spawnAs(arranged, caller.token);
      expect(started.status, await started.clone().text()).toBe(200);
      // The profile has `thread.start`, and the session's own profile does not.
      const widened = await spawnAs(arranged, caller.token, {
        permissionProfileId: withThreadStart.id,
      });
      expect(widened.status).toBe(403);
      expect(await parseRefusal(widened)).toMatchObject({
        code: "forbidden",
        grant: "thread.start",
      });
    });
  });
});

/** Forks a session with the given token, as `session.continue` does. */
const forkSession = (arranged: Arranged, id: string, token: string): Promise<Response> =>
  post(
    arranged.harness.base,
    `/api/v1/sessions/${id}/continue`,
    { mode: "fork", prompt: "carry this one on for me" },
    token,
  );

describe("a session forking a session", () => {
  it("may fork an Agent's session on its own profile, but not one on another profile", async () => {
    await withFleet(async (arranged) => {
      // The assistant profile is the built-in one with `session.spawn`, which
      // `session.continue` requires.
      const assistant = await readProfileNamed(arranged, "assistant");
      const mine = await spawnThreadUnder(arranged, assistant);

      // Two possible parents, each spawned from an Agent and exited with a
      // transcript on a connected runner, so both can be forked: one on this
      // session's own profile, and one on a narrower profile it may not use.
      // Neither is the calling session, whose token stops working when it
      // exits.
      const sibling = await spawnFromAgent(arranged, "sibling", assistant);
      const stranger = await spawnFromAgent(
        arranged,
        "stranger",
        await readProfileNamed(arranged, "worker"),
      );
      await exitSession(arranged, sibling);
      await exitSession(arranged, stranger);

      const theirs = await forkSession(arranged, stranger.id, mine.token);
      expect(theirs.status).toBe(403);
      const refusal = await parseRefusal(theirs);
      expect(refusal).toMatchObject({ code: "forbidden", grant: "session.spawn" });
      expect(refusal.message.toLowerCase()).toContain("profile");

      const own = await forkSession(arranged, sibling.id, mine.token);
      expect(own.status, await own.clone().text()).toBe(200);
      expect((await own.json()) as Session).toMatchObject({
        permissionProfileId: assistant.id,
        parentSessionId: sibling.id,
        agentId: sibling.agentId,
      });
    });
  });

  it("may fork a Thread on its own profile with thread.start, but not one on another profile, while the user may fork both", async () => {
    await withFleet(async (arranged) => {
      const own = await createProfile(arranged, "forker", THREAD_STARTER_GRANTS);
      const other = await createProfile(arranged, "other", ["session.spawn", "thread.start"]);
      const mine = await spawnThreadUnder(arranged, own);
      const sibling = await spawnThreadUnder(arranged, own);
      const stranger = await spawnThreadUnder(arranged, other);
      await exitSession(arranged, sibling.session);
      await exitSession(arranged, stranger.session);

      const forked = await forkSession(arranged, sibling.session.id, mine.token);
      expect(forked.status, await forked.clone().text()).toBe(200);
      expect((await forked.json()) as Session).toMatchObject({
        parentSessionId: sibling.session.id,
        agentId: null,
        permissionProfileId: own.id,
      });

      // The profile rule is the one that refuses here: the caller holds
      // `thread.start`, so the grant rule passes.
      const refused = await forkSession(arranged, stranger.session.id, mine.token);
      expect(refused.status).toBe(403);
      const refusal = await parseRefusal(refused);
      expect(refusal).toMatchObject({ code: "forbidden", grant: "session.spawn" });
      expect(refusal.message.toLowerCase()).toContain("profile");

      const byUser = await forkSession(arranged, stranger.session.id, arranged.token);
      expect(byUser.status, await byUser.clone().text()).toBe(200);
    });
  });

  it("may not fork a Thread without thread.start, even on its own profile", async () => {
    await withFleet(async (arranged) => {
      const assistant = await readProfileNamed(arranged, "assistant");
      const mine = await spawnThreadUnder(arranged, assistant);
      // A Thread on the caller's own profile, so the profile rule passes and
      // only the Thread rule can refuse the fork.
      const thread = await spawnThreadUnder(arranged, assistant);
      await exitSession(arranged, thread.session);

      const refused = await forkSession(arranged, thread.session.id, mine.token);

      expect(refused.status).toBe(403);
      expect(await parseRefusal(refused)).toMatchObject({
        code: "forbidden",
        grant: "thread.start",
      });
    });
  });
});

describe("which actor a change records", () => {
  it("records session:<id> on a session's task and event log rows, and user on the user's", async () => {
    await withFleet(async (arranged) => {
      const { session, token } = await spawnWorkerThread(arranged);
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
      const { token } = await spawnThreadUnder(
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
      const { token } = await spawnThreadUnder(
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
      const { token } = await spawnThreadUnder(
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
