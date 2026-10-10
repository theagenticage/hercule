/**
 * Tests Permission Requests over HTTP: a session refused a grant asks for it,
 * the user decides with each of the three outcomes, and the decision reaches
 * the session as queued input.
 *
 * A real fleet is needed because the asking credential is a session token,
 * which is only ever minted in a start frame on the runner socket. The fleet
 * runs the event router, because the decision is delivered through the
 * subscription `permission.request` opens.
 */
import { describe, expect, it, vi } from "vitest";
import type { Notification, PermissionRequest, Profile } from "@hercule/contract";
import {
  exitSession,
  readSubscriptionRow,
  runEffect,
  waitForMatchedInputRows,
  withPipeline,
} from "../daemon/testing";
import {
  createProfile,
  findInstanceId,
  readSession,
  readSessionToken,
  spawnThreadUnder,
  waitForStartFrames,
  WAIT_DEADLINE_MS,
  type Arranged,
  type SpawnedThread,
} from "../sessions/testing";
import { del, get, post, readErrorBody, send } from "./testing";

/** Starting the fleet is the slow part of each case; the timeout allows three waits. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

const REASON = "The task duplicates another one; deleting it keeps the list clean.";

interface RequestResult {
  readonly requestId: string;
  readonly subscriptionId: string;
}

/** Creates a task as the user and returns its id. */
const createTask = async (arranged: Arranged, title: string): Promise<string> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/tasks",
    { title, description: "" },
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { id: string }).id;
};

/** Deletes a task with a credential and returns the response. */
const deleteTask = (arranged: Arranged, taskId: string, token: string): Promise<Response> =>
  del(arranged.harness.base, `/api/v1/tasks/${taskId}`, token);

const requestPermission = (arranged: Arranged, body: unknown, token: string): Promise<Response> =>
  post(arranged.harness.base, "/api/v1/permissions/request", body, token);

/** Asks for `task.delete` as the thread and returns both ids. Fails the test if the ask fails. */
const requestTaskDelete = async (
  arranged: Arranged,
  thread: SpawnedThread,
  taskId: string,
): Promise<RequestResult> => {
  const response = await requestPermission(
    arranged,
    {
      grant: "task.delete",
      reason: REASON,
      operation: { op: "task.delete", input: { id: taskId } },
    },
    thread.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as RequestResult;
};

const decide = (arranged: Arranged, requestId: string, outcome: string): Promise<Response> =>
  post(
    arranged.harness.base,
    `/api/v1/permissions/requests/${requestId}/decide`,
    { outcome },
    arranged.token,
  );

/** Returns the Permission Request notifications about one request, newest first. */
const readRequestNotifications = async (
  arranged: Arranged,
  requestId: string,
): Promise<ReadonlyArray<Notification>> => {
  const response = await get(
    arranged.harness.base,
    "/api/v1/notifications?kind=core.permission-request",
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const page = (await response.json()) as { readonly items: ReadonlyArray<Notification> };
  return page.items.filter((notification) =>
    (notification.subject ?? []).some(
      (subject) => subject.kind === "permissionRequest" && subject.id === requestId,
    ),
  );
};

/** Returns the one notification about a request. */
const readRequestNotification = async (
  arranged: Arranged,
  requestId: string,
): Promise<Notification> => {
  const found = await readRequestNotifications(arranged, requestId);
  expect(found).toHaveLength(1);
  return found[0]!;
};

/** Returns the open Permission Requests the session's record lists. */
const readOpenRequests = async (
  arranged: Arranged,
  sessionId: string,
): Promise<ReadonlyArray<PermissionRequest>> =>
  (await readSession(arranged, sessionId)).openPermissionRequests;

/** Spawns two Threads on one new profile that grants only `task.read`. */
const spawnTwoWorkers = async (
  arranged: Arranged,
): Promise<{ profile: Profile; asker: SpawnedThread; other: SpawnedThread }> => {
  const profile = await createProfile(arranged, "worker-under-test", ["task.read"]);
  const asker = await spawnThreadUnder(arranged, profile);
  const other = await spawnThreadUnder(arranged, profile);
  return { profile, asker, other };
};

describe("permission.request", () => {
  it("raises a decision with three answers, lists the request on the session, and audits it", async () => {
    await withPipeline(async (arranged) => {
      const { profile, asker } = await spawnTwoWorkers(arranged);
      const taskId = await createTask(arranged, "Duplicate");

      const refused = await readErrorBody(await deleteTask(arranged, taskId, asker.token));
      expect(refused.code).toBe("forbidden");
      expect(refused.grant).toBe("task.delete");

      const { requestId, subscriptionId } = await requestTaskDelete(arranged, asker, taskId);
      expect(subscriptionId).toMatch(/^[0-9a-f-]{36}$/);

      const notification = await readRequestNotification(arranged, requestId);
      expect(notification.status).toBe("open");
      expect(notification.title).toContain("`task.delete`");
      expect(notification.body).toContain(REASON);
      expect(notification.body).toContain(profile.name);
      expect(notification.body).toContain(taskId);
      expect(notification.subject).toContainEqual({ kind: "session", id: asker.session.id });
      expect(
        notification.actions.map(({ id, label, description }) => ({ id, label, description })),
      ).toEqual([
        {
          id: "session",
          label: "This session only",
          description: "Lets this session use task.delete; other sessions still ask.",
        },
        {
          id: "profile",
          label: "Add to profile",
          description: `Adds task.delete to the profile ${profile.name}; every session on it gains the grant.`,
        },
        {
          id: "deny",
          label: "Deny",
          description: "Refuses task.delete; the agent is told and continues.",
        },
      ]);

      expect(notification.actions.some((action) => action.primary === true)).toBe(false);

      const open = await readOpenRequests(arranged, asker.session.id);
      expect(open).toEqual([
        expect.objectContaining({
          id: requestId,
          grant: "task.delete",
          reason: REASON,
          operation: { op: "task.delete", input: { id: taskId } },
        }),
      ]);

      const audited = await runEffect(
        arranged.harness.sql<{ readonly actor: string; readonly payload: string }>`
          SELECT actor, payload FROM events WHERE kind = 'permission.requested'`,
      );
      expect(audited).toHaveLength(1);
      expect(audited[0]!.actor).toBe(`session:${asker.session.id}`);
      expect(JSON.parse(audited[0]!.payload)).toMatchObject({
        requestId,
        sessionId: asker.session.id,
        grant: "task.delete",
        reason: REASON,
      });
    });
  });

  it("refuses a second request for the same grant, a held grant, and a caller that is not a session", async () => {
    await withPipeline(async (arranged) => {
      const { asker } = await spawnTwoWorkers(arranged);
      const taskId = await createTask(arranged, "Duplicate");
      const { requestId } = await requestTaskDelete(arranged, asker, taskId);

      const again = await readErrorBody(
        await requestPermission(arranged, { grant: "task.delete", reason: REASON }, asker.token),
      );
      expect(again.code).toBe("invalid_state");
      expect(again.message).toContain(requestId);

      const held = await readErrorBody(
        await requestPermission(arranged, { grant: "task.read", reason: REASON }, asker.token),
      );
      expect(held.code).toBe("invalid_state");
      expect(held.message).toMatch(/already holds task\.read; retry the call/);

      const user = await readErrorBody(
        await requestPermission(arranged, { grant: "task.delete", reason: REASON }, arranged.token),
      );
      expect(user.code).toBe("validation");
      expect(user.message).toMatch(/only a session can ask/);
    });
  });
  it("refuses an operation whose input can carry a secret, and names what to send instead", async () => {
    await withPipeline(async (arranged) => {
      const { asker } = await spawnTwoWorkers(arranged);

      const refused = await readErrorBody(
        await requestPermission(
          arranged,
          {
            grant: "secret.write",
            reason: REASON,
            operation: { op: "secret.set", input: { name: "deploy", value: "hunter2" } },
          },
          asker.token,
        ),
      );
      expect(refused.code).toBe("validation");
      expect(refused.message).toMatch(/send the request without operation/);
      expect(refused.message).not.toContain("hunter2");
      expect(await readOpenRequests(arranged, asker.session.id)).toEqual([]);
    });
  });

  it("accepts a request for another grant while one is open", async () => {
    await withPipeline(async (arranged) => {
      const { asker } = await spawnTwoWorkers(arranged);
      const taskId = await createTask(arranged, "Duplicate");
      await requestTaskDelete(arranged, asker, taskId);

      const second = await requestPermission(
        arranged,
        { grant: "task.create", reason: REASON },
        asker.token,
      );
      expect(second.status, await second.clone().text()).toBe(200);
      const open = await readOpenRequests(arranged, asker.session.id);
      expect(open.map((request) => request.grant).sort()).toEqual(["task.create", "task.delete"]);
    });
  });
});

describe("permission.decide", () => {
  it("lets only the asking session through with outcome session, and tells it", async () => {
    await withPipeline(async (arranged) => {
      const { asker, other } = await spawnTwoWorkers(arranged);
      const first = await createTask(arranged, "First");
      const second = await createTask(arranged, "Second");
      const { requestId, subscriptionId } = await requestTaskDelete(arranged, asker, first);

      const decided = await decide(arranged, requestId, "session");
      expect(decided.status, await decided.clone().text()).toBe(200);

      expect((await deleteTask(arranged, first, asker.token)).status).toBe(200);
      const refused = await readErrorBody(await deleteTask(arranged, second, other.token));
      expect(refused.code).toBe("forbidden");

      expect(await readOpenRequests(arranged, asker.session.id)).toEqual([]);
      const notification = await readRequestNotification(arranged, requestId);
      expect(notification.status).toBe("resolved");
      expect(notification.resolution).toMatchObject({ kind: "decided", actionId: "session" });

      const rows = await waitForMatchedInputRows(
        arranged.harness,
        subscriptionId,
        (found) => found.length > 0,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.text).toContain("permission.decided");
      expect(rows[0]!.text).toContain(requestId);
      // The subscription waits for one decision, so it ends once that is delivered.
      const ended = await readSubscriptionRow(arranged.harness, subscriptionId);
      expect(ended?.ended_reason).toMatch(/was decided/);
      expect(ended?.ended_actor).toBe("system");

      const twice = await readErrorBody(await decide(arranged, requestId, "deny"));
      expect(twice.code).toBe("invalid_state");
      expect(twice.message).toMatch(/already decided with outcome session/);
    });
  });

  it("adds the grant to the profile when the user answers the notification with profile", async () => {
    await withPipeline(async (arranged) => {
      const { profile, asker, other } = await spawnTwoWorkers(arranged);
      const taskId = await createTask(arranged, "Duplicate");
      const { requestId } = await requestTaskDelete(arranged, asker, taskId);
      const notification = await readRequestNotification(arranged, requestId);

      const acted = await post(
        arranged.harness.base,
        `/api/v1/notifications/${notification.id}/act`,
        { actionId: "profile" },
        arranged.token,
      );
      expect(acted.status, await acted.clone().text()).toBe(200);
      expect(((await acted.json()) as Notification).resolution).toMatchObject({
        kind: "decided",
        actionId: "profile",
      });

      const read = await get(
        arranged.harness.base,
        `/api/v1/profiles/${profile.id}`,
        arranged.token,
      );
      expect(((await read.json()) as Profile).grants).toEqual(["task.read", "task.delete"]);
      // The other session on the profile holds the grant from its next call.
      expect((await deleteTask(arranged, taskId, other.token)).status).toBe(200);
    });
  });

  it("changes nothing with outcome deny, and still tells the session", async () => {
    await withPipeline(async (arranged) => {
      const { asker } = await spawnTwoWorkers(arranged);
      const taskId = await createTask(arranged, "Duplicate");
      const { requestId, subscriptionId } = await requestTaskDelete(arranged, asker, taskId);

      expect((await decide(arranged, requestId, "deny")).status).toBe(200);

      expect((await readErrorBody(await deleteTask(arranged, taskId, asker.token))).code).toBe(
        "forbidden",
      );
      const rows = await waitForMatchedInputRows(
        arranged.harness,
        subscriptionId,
        (found) => found.length > 0,
      );
      expect(rows[0]!.text).toContain("deny");
    });
  });

  it("refuses a request id that does not exist", async () => {
    await withPipeline(async (arranged) => {
      const missing = await readErrorBody(
        await decide(arranged, "0192f0a1-0000-7000-8000-00000000dead", "deny"),
      );
      expect(missing.code).toBe("not_found");
    });
  });

  it("withdraws the open request and its notification when the session ends", async () => {
    await withPipeline(async (arranged) => {
      const { asker } = await spawnTwoWorkers(arranged);
      const taskId = await createTask(arranged, "Duplicate");
      const { requestId, subscriptionId } = await requestTaskDelete(arranged, asker, taskId);

      await exitSession(arranged, asker, 2);

      const notification = await readRequestNotification(arranged, requestId);
      expect(notification.resolution).toMatchObject({
        kind: "withdrawn",
        reason: "The session ended before the request was answered.",
      });
      const late = await readErrorBody(await decide(arranged, requestId, "session"));
      expect(late.code).toBe("invalid_state");
      expect(late.message).toMatch(/withdrawn because its session ended/);
      const ended = await readSubscriptionRow(arranged.harness, subscriptionId);
      expect(ended?.ended_reason).toMatch(/the request was withdrawn/);
    });
  });

  it("resolves the notification with profile when the profile already holds the grant", async () => {
    await withPipeline(async (arranged) => {
      const { profile, asker } = await spawnTwoWorkers(arranged);
      const taskId = await createTask(arranged, "Duplicate");
      const { requestId } = await requestTaskDelete(arranged, asker, taskId);
      // The user adds the grant by editing the profile while the request is open.
      const edited = await send("PATCH", arranged.harness.base, `/api/v1/profiles/${profile.id}`, {
        body: { grants: ["task.read", "task.delete"] },
        token: arranged.token,
      });
      expect(edited.status, await edited.clone().text()).toBe(200);

      const decided = await decide(arranged, requestId, "profile");
      expect(decided.status, await decided.clone().text()).toBe(200);

      const read = await get(
        arranged.harness.base,
        `/api/v1/profiles/${profile.id}`,
        arranged.token,
      );
      expect(((await read.json()) as Profile).grants).toEqual(["task.read", "task.delete"]);
      expect((await readRequestNotification(arranged, requestId)).resolution).toMatchObject({
        kind: "decided",
        actionId: "profile",
      });
    });
  });
});

describe("a grant decided with outcome session", () => {
  it("lasts across a resume on the same profile", async () => {
    await withPipeline(async (arranged) => {
      const { asker } = await spawnTwoWorkers(arranged);
      const taskId = await createTask(arranged, "Duplicate");
      const { requestId } = await requestTaskDelete(arranged, asker, taskId);
      expect((await decide(arranged, requestId, "session")).status).toBe(200);
      await exitSession(arranged, asker, 2);

      const resumed = await post(
        arranged.harness.base,
        `/api/v1/sessions/${asker.session.id}/input`,
        { text: "carry on" },
        arranged.token,
      );
      expect(resumed.status, await resumed.clone().text()).toBe(200);
      const starts = await waitForStartFrames(arranged, asker.session.id, 2);
      const token = readSessionToken(starts[1]!);

      expect((await deleteTask(arranged, taskId, token)).status).toBe(200);
    });
  });

  it("does not let the session spawn an Agent whose profile holds that grant", async () => {
    await withPipeline(async (arranged) => {
      const spawner = await spawnThreadUnder(
        arranged,
        await createProfile(arranged, "spawner", ["task.read", "session.spawn", "session.read"]),
      );
      const taskId = await createTask(arranged, "Duplicate");
      const { requestId } = await requestTaskDelete(arranged, spawner, taskId);
      expect((await decide(arranged, requestId, "session")).status).toBe(200);
      // The session holds task.delete itself now.
      expect((await deleteTask(arranged, taskId, spawner.token)).status).toBe(200);

      const created = await post(
        arranged.harness.base,
        "/api/v1/agents",
        {
          name: "deleter",
          systemPrompt: "You delete tasks.",
          instanceId: findInstanceId(arranged, "full-provider"),
          permissionProfileId: (await createProfile(arranged, "deleter", ["task.delete"])).id,
        },
        arranged.token,
      );
      expect(created.status, await created.clone().text()).toBe(200);
      const agent = (await created.json()) as { readonly id: string };

      const refused = await post(
        arranged.harness.base,
        "/api/v1/sessions",
        { agentId: agent.id, prompt: "delete them all" },
        spawner.token,
      );
      expect(refused.status).toBe(403);
      expect(await readErrorBody(refused)).toMatchObject({
        code: "forbidden",
        grant: "session.spawn",
      });
    });
  });
});
