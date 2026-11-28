/**
 * Tests `session.archive` over HTTP against a real controller and one fake
 * runner:
 *
 * - an archived idle Thread is marked Done, audited, and its runner is told to
 *   stop it, while its lease keeps the workspace until the Thread exits;
 * - a sidebar row is archived whole: when the call leaves a workspace with no
 *   Thread that is not archived, the Agent sessions of the workspace follow,
 *   and the workspace goes back to automatic cleanup;
 * - a working session refuses the whole call and nothing is written;
 * - the archive cancels the waiting input, ends the subscriptions and
 *   withdraws the Permission Requests of every session it archives;
 * - only the user archives, and a runner that is offline does not fail it.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { SessionStop } from "@hercule/protocol";
import type { Notification, Session, Workspace } from "@hercule/contract";
import { mintUuid, withTransaction } from "../../db";
import { get, post, readErrorBody, send } from "../../http/testing";
import {
  at,
  createProfile,
  listFrames,
  listInputs,
  readApprovalNotifications,
  readProfileNamed,
  readSession,
  reportEvent,
  reportTurnCompleted,
  reportTurnStarted,
  spawnSessionOrFail,
  spawnThreadUnder,
  spawnThreadWithGrants,
  waitForFrames,
  waitForRunnerGone,
  waitForSession,
  waitForStartFrames,
  WAIT_DEADLINE_MS,
  type Arranged,
} from "../../sessions/testing";
import { readWorkspace, spawnThread, withFleet } from "../../workspaces/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

const SCRATCH_WORKSPACE = { kind: "ephemeral", checkouts: [] } as const;

/** Archives sessions over HTTP, as the user unless a token is given. */
const archive = (
  arranged: Arranged,
  ids: ReadonlyArray<string>,
  token = arranged.token,
): Promise<Response> =>
  send("POST", arranged.harness.base, "/api/v1/sessions/archive", {
    token,
    body: { sessionIds: ids },
  });

/** Returns the sessions of a 200 response, and fails the test on any other status. */
const readArchived = async (response: Response): Promise<ReadonlyArray<Session>> => {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ReadonlyArray<Session>;
};

const countStopFrames = (arranged: Arranged): number =>
  listFrames<SessionStop>(arranged.wire, "sessionStop").length;

/** Waits until the runner has been told to stop `count` sessions, and returns their ids. */
const waitForStops = async (arranged: Arranged, count: number): Promise<ReadonlyArray<string>> =>
  (await waitForFrames<SessionStop>(arranged.wire, "sessionStop", count)).map(
    (frame) => frame.sessionId,
  );

/** Reports the session's prompt turn as done, so it is `idle`. */
const makeIdle = async (arranged: Arranged, session: Session): Promise<Session> => {
  reportTurnStarted(arranged, session.id, 2);
  reportTurnCompleted(arranged, session.id, 3);
  return waitForSession(arranged, session.id, (one) => one.status === "idle");
};

/** Starts a Thread in the workspace asked for, and leaves it busy with its prompt's turn. */
const startThread = (arranged: Arranged, workspace: unknown): Promise<Session> =>
  spawnThread(arranged, workspace, listFrames(arranged.wire, "sessionStart").length + 1);

/** Starts a Thread in a new scratch workspace and leaves it idle. */
const startIdleThreadInNewWorkspace = async (arranged: Arranged): Promise<Session> =>
  makeIdle(arranged, await startThread(arranged, SCRATCH_WORKSPACE));

/** Starts a Thread in an existing workspace and leaves it idle. */
const startIdleThreadIn = async (arranged: Arranged, workspaceId: string): Promise<Session> =>
  makeIdle(arranged, await startThread(arranged, { kind: "existing", workspaceId }));

/** Starts an Agent session in an existing workspace. It stays busy until `makeIdle`. */
const startAgentSessionIn = async (arranged: Arranged, workspaceId: string): Promise<Session> => {
  const worker = await readProfileNamed(arranged, "worker");
  const created = await post(
    arranged.harness.base,
    "/api/v1/agents",
    {
      name: `assessor-${crypto.randomUUID().slice(0, 8)}`,
      systemPrompt: "You assess tasks.",
      providerAccountId: arranged.accounts[0]!.id,
      permissionProfileId: worker.id,
    },
    arranged.token,
  );
  expect(created.status, await created.clone().text()).toBe(200);
  const agent = (await created.json()) as { readonly id: string };
  const spawned = await spawnSessionOrFail(arranged, {
    agentId: agent.id,
    prompt: "assess",
    workspace: { kind: "existing", workspaceId },
  });
  await waitForStartFrames(arranged, spawned.id, 1);
  reportEvent(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: spawned.id,
    at,
    _tag: "session.started",
  });
  return waitForSession(arranged, spawned.id, (one) => one.status === "busy");
};

const readPolicy = async (arranged: Arranged, workspaceId: string): Promise<string> =>
  ((await readWorkspace(arranged, workspaceId)) as Workspace & { retentionPolicy: string })
    .retentionPolicy;

interface LeaseRow {
  readonly holder: string;
  readonly released_at: string | null;
  readonly retention: string | null;
  readonly kept_until: string | null;
}

/** Reads the leases of a workspace, each named by its holder session's id. */
const readLeases = (arranged: Arranged, workspaceId: string): Promise<ReadonlyArray<LeaseRow>> =>
  Effect.runPromise(
    Effect.orDie(
      arranged.harness.sql<LeaseRow>`
        SELECT lower(hex(holder_id)) AS holder, released_at, retention, kept_until
        FROM workspace_leases
        WHERE workspace_id = unhex(replace(${workspaceId}, '-', ''))`,
    ),
  );

const leaseOf = (leases: ReadonlyArray<LeaseRow>, session: Session): LeaseRow => {
  const found = leases.find((lease) => lease.holder === session.id.replaceAll("-", ""));
  expect(found, `a lease held by ${session.id}`).toBeDefined();
  return found!;
};

/** Has the runner report that the session exited, at the next sequence number. */
const reportCrash = (arranged: Arranged, session: Session, seq: number): void =>
  reportEvent(arranged.wire, seq, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at,
    _tag: "session.exited",
    reason: "crash",
  });

describe("session.archive", () => {
  it("marks an idle Thread Done and archived as the user, audits both, and tells its runner to stop it", async () => {
    await withFleet(async (arranged) => {
      const thread = await startIdleThreadInNewWorkspace(arranged);

      const [archived] = await readArchived(await archive(arranged, [thread.id]));

      expect(archived!.archived?.by).toBe("user");
      expect(archived!.done).toEqual(archived!.archived);
      const entries = await arranged.harness.audit("session.archived");
      expect(entries.map((one) => [one.actor, one.payload])).toEqual([
        ["user", { sessionId: thread.id, runnerId: thread.runnerId, threadId: thread.id }],
      ]);
      expect(
        (await arranged.harness.audit("session.markedDone")).map((one) => one.payload),
      ).toEqual([{ sessionId: thread.id }]);
      expect(await waitForStops(arranged, 1)).toEqual([thread.id]);
      expect(
        (await arranged.harness.audit("session.stopped")).map((one) => [one.actor, one.payload]),
      ).toEqual([["user", { sessionId: thread.id, runnerId: arranged.runnerId }]]);
    });
  });

  it("keeps the workspace safe from removal until the Thread exits, then releases its lease", async () => {
    await withFleet(async (arranged) => {
      const thread = await startIdleThreadInNewWorkspace(arranged);
      const workspaceId = thread.workspaceId!;
      expect(await readPolicy(arranged, workspaceId)).toBe("manual");

      await readArchived(await archive(arranged, [thread.id]));

      // The Thread still runs on its runner, so its lease is still active.
      expect(await readPolicy(arranged, workspaceId)).toBe("automatic");
      expect(leaseOf(await readLeases(arranged, workspaceId), thread).released_at).toBeNull();

      reportCrash(arranged, thread, 4);
      await waitForSession(arranged, thread.id, (one) => one.status === "exited");
      expect(leaseOf(await readLeases(arranged, workspaceId), thread).released_at).not.toBeNull();
    });
  });

  it("archives a row whole: its Threads and the Agent sessions that share their workspace", async () => {
    await withFleet(async (arranged) => {
      const first = await startIdleThreadInNewWorkspace(arranged);
      const workspaceId = first.workspaceId!;
      const second = await startIdleThreadIn(arranged, workspaceId);
      const agentSession = await makeIdle(
        arranged,
        await startAgentSessionIn(arranged, workspaceId),
      );
      const elsewhere = await startIdleThreadInNewWorkspace(arranged);

      const archived = await readArchived(await archive(arranged, [second.id, first.id]));

      // The Threads come back in the order given, without the Agent session.
      expect(archived.map((one) => one.id)).toEqual([second.id, first.id]);
      const followed = await readSession(arranged, agentSession.id);
      expect(followed.archived?.at).toBe(archived[0]!.archived?.at);
      expect("done" in followed).toBe(false);
      expect("archived" in (await readSession(arranged, elsewhere.id))).toBe(false);
      const entries = await arranged.harness.audit("session.archived");
      expect(entries).toHaveLength(3);
      expect(entries.find((one) => one.payload["sessionId"] === agentSession.id)?.payload).toEqual({
        sessionId: agentSession.id,
        runnerId: agentSession.runnerId,
        threadId: second.id,
      });
      expect([...(await waitForStops(arranged, 3))].sort()).toEqual(
        [first.id, second.id, agentSession.id].sort(),
      );
      expect(await readPolicy(arranged, workspaceId)).toBe("automatic");
    });
  });

  it("leaves the Agent sessions and the manual policy alone while another Thread of the workspace is not archived", async () => {
    await withFleet(async (arranged) => {
      const first = await startIdleThreadInNewWorkspace(arranged);
      const workspaceId = first.workspaceId!;
      await startIdleThreadIn(arranged, workspaceId);
      const agentSession = await makeIdle(
        arranged,
        await startAgentSessionIn(arranged, workspaceId),
      );

      await readArchived(await archive(arranged, [first.id]));

      expect("archived" in (await readSession(arranged, agentSession.id))).toBe(false);
      expect(await readPolicy(arranged, workspaceId)).toBe("manual");
      expect(await arranged.harness.audit("session.archived")).toHaveLength(1);
      expect(await waitForStops(arranged, 1)).toEqual([first.id]);
    });
  });

  it("gives the workspace back when the last Thread is archived, counting a Thread archived by an earlier call", async () => {
    await withFleet(async (arranged) => {
      const first = await startIdleThreadInNewWorkspace(arranged);
      const workspaceId = first.workspaceId!;
      const second = await startIdleThreadIn(arranged, workspaceId);
      await readArchived(await archive(arranged, [first.id]));
      reportCrash(arranged, first, 4);
      await waitForSession(arranged, first.id, (one) => one.status === "exited");
      const released = leaseOf(await readLeases(arranged, workspaceId), first);
      expect(released.released_at).not.toBeNull();
      expect(await readPolicy(arranged, workspaceId)).toBe("manual");

      await readArchived(await archive(arranged, [second.id]));

      expect(await readPolicy(arranged, workspaceId)).toBe("automatic");
      const leases = await readLeases(arranged, workspaceId);
      const earlier = leaseOf(leases, first);
      // The window counts from the exit that released the lease, not from the second call.
      expect(earlier.retention).toBe("archived");
      expect(earlier.released_at).toBe(released.released_at);
      expect(Date.parse(earlier.kept_until!) - Date.parse(earlier.released_at!)).toBe(
        7 * 24 * 60 * 60 * 1000,
      );
      // The second Thread still runs, so its lease stays active.
      expect(leaseOf(leases, second)).toMatchObject({ released_at: null, retention: null });
    });
  });

  it("refuses the whole call, and writes nothing, while a Thread is working", async () => {
    await withFleet(async (arranged) => {
      const idle = await startIdleThreadInNewWorkspace(arranged);
      const busy = await startThread(arranged, {
        kind: "existing",
        workspaceId: idle.workspaceId!,
      });
      const other = await startIdleThreadInNewWorkspace(arranged);

      const refused = await archive(arranged, [other.id, idle.id, busy.id]);

      expect(refused.status).toBe(409);
      const body = await readErrorBody(refused);
      expect(body.code).toBe("invalid_state");
      expect(body.message).toBe(
        `${busy.title} is working. Stop it first, or wait for its turn to end.`,
      );
      for (const session of [idle, busy, other]) {
        const read = await readSession(arranged, session.id);
        expect("archived" in read || "done" in read).toBe(false);
      }
      expect(await arranged.harness.audit("session.archived")).toEqual([]);
      expect(await arranged.harness.audit("session.markedDone")).toEqual([]);
      expect(countStopFrames(arranged)).toBe(0);
    });
  });

  it("refuses the call while an Agent session that would follow the Thread is working, naming it", async () => {
    await withFleet(async (arranged) => {
      const thread = await startIdleThreadInNewWorkspace(arranged);
      const agentSession = await startAgentSessionIn(arranged, thread.workspaceId!);

      const refused = await archive(arranged, [thread.id]);

      expect(refused.status).toBe(409);
      expect((await readErrorBody(refused)).message).toBe(
        `${agentSession.title} is working. Stop it first, or wait for its turn to end.`,
      );
      expect("archived" in (await readSession(arranged, thread.id))).toBe(false);
      expect(await arranged.harness.audit("session.archived")).toEqual([]);
      expect(await arranged.harness.audit("session.markedDone")).toEqual([]);
      expect(countStopFrames(arranged)).toBe(0);
      expect(await readPolicy(arranged, thread.workspaceId!)).toBe("manual");
    });
  });

  it("names every working session at once: a named Thread first, then the Agent session that would follow", async () => {
    await withFleet(async (arranged) => {
      const idle = await startIdleThreadInNewWorkspace(arranged);
      const busy = await startThread(arranged, {
        kind: "existing",
        workspaceId: idle.workspaceId!,
      });
      const agentSession = await startAgentSessionIn(arranged, idle.workspaceId!);

      const refused = await archive(arranged, [idle.id, busy.id]);

      expect(refused.status).toBe(409);
      expect((await readErrorBody(refused)).message).toBe(
        `${busy.title} and ${agentSession.title} are working. Stop them first, or wait for their turns to end.`,
      );
      for (const session of [idle, busy, agentSession]) {
        const read = await readSession(arranged, session.id);
        expect("archived" in read || "done" in read).toBe(false);
      }
      expect(await arranged.harness.audit("session.archived")).toEqual([]);
      expect(await arranged.harness.audit("session.markedDone")).toEqual([]);
      expect(countStopFrames(arranged)).toBe(0);
      expect(await readPolicy(arranged, idle.workspaceId!)).toBe("manual");
    });
  });

  it("refuses an unknown id and a session that is not a Thread, writing nothing", async () => {
    await withFleet(async (arranged) => {
      const thread = await startIdleThreadInNewWorkspace(arranged);
      const agentSession = await makeIdle(
        arranged,
        await startAgentSessionIn(arranged, thread.workspaceId!),
      );
      const unknown = "01890a5d-ac96-774b-bcce-b302099a8057";

      const notFound = await archive(arranged, [thread.id, unknown]);
      expect(notFound.status).toBe(404);
      expect((await readErrorBody(notFound)).code).toBe("not_found");

      const notAThread = await archive(arranged, [thread.id, agentSession.id]);
      expect(notAThread.status).toBe(409);
      expect((await readErrorBody(notAThread)).message).toBe(
        "Only a Thread can be archived. Stop an Agent's session with `session.stop`.",
      );
      expect("archived" in (await readSession(arranged, thread.id))).toBe(false);
      expect(await arranged.harness.audit("session.archived")).toEqual([]);
    });
  });

  it("leaves a Thread that is already archived as it is, with no audit entry and no second stop", async () => {
    await withFleet(async (arranged) => {
      const thread = await startIdleThreadInNewWorkspace(arranged);
      const [first] = await readArchived(await archive(arranged, [thread.id]));

      const [again] = await readArchived(await archive(arranged, [thread.id]));

      expect(again).toEqual(first);
      expect(await arranged.harness.audit("session.archived")).toHaveLength(1);
      expect(await arranged.harness.audit("session.markedDone")).toHaveLength(1);
      expect(await arranged.harness.audit("session.stopped")).toHaveLength(1);
      expect(await waitForStops(arranged, 1)).toEqual([thread.id]);
    });
  });

  it("keeps a Done mark that is already there", async () => {
    await withFleet(async (arranged) => {
      const thread = await startIdleThreadInNewWorkspace(arranged);
      const done = await send("POST", arranged.harness.base, "/api/v1/sessions/mark-done", {
        token: arranged.token,
        body: { sessionIds: [thread.id] },
      });
      const [marked] = (await done.json()) as ReadonlyArray<Session>;

      const [archived] = await readArchived(await archive(arranged, [thread.id]));

      expect(archived!.done).toEqual(marked!.done);
      expect(await arranged.harness.audit("session.markedDone")).toHaveLength(1);
    });
  });

  it("refuses a session's token, whatever its profile holds, and archives nothing", async () => {
    await withFleet(async (arranged) => {
      const thread = await startIdleThreadInNewWorkspace(arranged);
      const steerer = await spawnThreadWithGrants(arranged, "steerer", ["session.steer"]);

      const refused = await archive(arranged, [thread.id], steerer.token);

      expect(refused.status).toBe(403);
      const body = await readErrorBody(refused);
      expect(body.code).toBe("forbidden");
      expect(body.message).toContain("cannot archive");
      expect("archived" in (await readSession(arranged, thread.id))).toBe(false);
      expect(await arranged.harness.audit("session.archived")).toEqual([]);
    });
  });

  it("refuses more ids than one page", async () => {
    await withFleet(async (arranged) => {
      const ids = Array.from({ length: 501 }, () => crypto.randomUUID());

      const refused = await archive(arranged, ids);

      expect(refused.status).toBe(400);
      expect((await readErrorBody(refused)).code).toBe("validation");
    });
  });

  it("cancels the waiting input, ends the subscriptions and withdraws the Permission Requests", async () => {
    await withFleet(async (arranged) => {
      const profile = await createProfile(arranged, "waiter", ["task.read", "subscription.write"]);
      const waiter = await spawnThreadUnder(arranged, profile);
      const idle = await makeIdle(arranged, waiter.session);
      const subscribed = await post(
        arranged.harness.base,
        "/api/v1/subscriptions",
        { target: { kind: "ref", ref: "github:pr:o/r#87" } },
        waiter.token,
      );
      expect(subscribed.status, await subscribed.clone().text()).toBe(200);
      const asked = await post(
        arranged.harness.base,
        "/api/v1/permissions/request",
        { grant: "task.delete", reason: "Clean up." },
        waiter.token,
      );
      expect(asked.status, await asked.clone().text()).toBe(200);
      const { requestId } = (await asked.json()) as { requestId: string };
      await Effect.runPromise(
        Effect.orDie(
          withTransaction(
            arranged.harness.sql,
            arranged.harness.sql`
              INSERT INTO session_inputs (id, session_id, source, actor, text, status, created_at)
              VALUES (${mintUuid()},
                unhex(replace(${idle.id}, '-', '')), 'user', 'user', 'later', 'queued', ${at})`,
          ),
        ),
      );
      expect((await readSession(arranged, idle.id)).openPermissionRequests).toHaveLength(1);

      await readArchived(await archive(arranged, [idle.id]));

      const waiting = (await listInputs(arranged, idle.id)).filter((one) => one.text === "later");
      expect(waiting.map((one) => one.status)).toEqual(["cancelled"]);
      expect(waiting[0]!.reason).toMatch(/archived/);
      expect((await readSession(arranged, idle.id)).openPermissionRequests).toEqual([]);
      const ended = await Effect.runPromise(
        Effect.orDie(
          arranged.harness.sql<{
            readonly ended_at: string | null;
            readonly ended_actor: string | null;
          }>`
            SELECT ended_at, ended_actor FROM subscriptions
            WHERE holder_id = unhex(replace(${idle.id}, '-', ''))`,
        ),
      );
      expect(ended).toHaveLength(2);
      expect(ended.every((one) => one.ended_at !== null && one.ended_actor === "user")).toBe(true);
      const notifications = await get(
        arranged.harness.base,
        "/api/v1/notifications?kind=core.permission-request",
        arranged.token,
      );
      const page = (await notifications.json()) as { readonly items: ReadonlyArray<Notification> };
      const about = page.items.filter((one) =>
        (one.subject ?? []).some(
          (subject) => subject.kind === "permissionRequest" && subject.id === requestId,
        ),
      );
      expect(about.map((one) => one.resolution)).toEqual([
        expect.objectContaining({
          kind: "withdrawn",
          reason: "The session was archived before the request was answered.",
        }),
      ]);
    });
  });

  it("withdraws the approval notification of a subagent's open Request even when the runner is not connected", async () => {
    await withFleet(async (arranged) => {
      const thread = await spawnThread(arranged, SCRATCH_WORKSPACE, 1);
      const base = (subagentId?: string) => ({
        eventId: crypto.randomUUID(),
        sessionId: thread.id,
        at,
        ...(subagentId === undefined ? {} : { subagentId }),
      });
      reportEvent(arranged.wire, 2, { ...base(), _tag: "turn.started", turnId: "t1" });
      reportEvent(arranged.wire, 3, { ...base(), _tag: "subagent.started", subagentId: "a1" });
      reportEvent(arranged.wire, 4, {
        ...base("a1"),
        _tag: "request.opened",
        request: {
          requestId: "sub-req",
          itemId: "i1",
          kind: "command_approval",
          decisions: ["allow", "deny"],
          detail: { command: "ls" },
        },
      });
      // The Thread's own turn ends; the subagent's Request stays open.
      reportEvent(arranged.wire, 5, {
        ...base(),
        _tag: "turn.completed",
        turnId: "t1",
        state: "completed",
      });
      await waitForSession(arranged, thread.id, (one) => one.status === "idle");
      expect(
        (await readApprovalNotifications(arranged, thread.id)).map((one) => one.status),
      ).toEqual(["open"]);
      arranged.wire.close();
      await waitForRunnerGone(arranged);

      await readArchived(await archive(arranged, [thread.id]));

      const [notification] = await readApprovalNotifications(arranged, thread.id);
      expect(notification!.resolution).toMatchObject({
        kind: "withdrawn",
        reason: "The session was archived before the request was answered.",
      });
    });
  });

  it("succeeds when the runner is not connected, leaving the stop for when it reports in again", async () => {
    await withFleet(async (arranged) => {
      const thread = await startIdleThreadInNewWorkspace(arranged);
      arranged.wire.close();
      await waitForRunnerGone(arranged);

      const [archived] = await readArchived(await archive(arranged, [thread.id]));

      expect(archived!.archived?.by).toBe("user");
      expect(countStopFrames(arranged)).toBe(0);
      expect(await arranged.harness.audit("session.stopped")).toEqual([]);
      expect(await arranged.harness.audit("session.archived")).toHaveLength(1);
    });
  });
});
