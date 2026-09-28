/**
 * Tests `notification.act` over HTTP: the user takes an answer of an open
 * decision, its operation runs as the user, and the decision is resolved with
 * that answer. When anything goes wrong, the decision stays open.
 *
 * Most decisions are inserted straight into the table, so a test can store an
 * answer that `notification.create` would reject. The task an answer
 * updates is created over HTTP like any other. The cases with a session run
 * against a fake runner, and create their decisions the way the core or an
 * agent does.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SessionInput, SessionRespond } from "@hercule/protocol";
import type { BoundAction, Notification, Session, Task } from "@hercule/contract";
import { completeSetup, get, post, readErrorBody, withServer } from "../http/testing";
import type { ServerHarness } from "../http/testing";
import { insertOpenDecision } from "./testing";
import {
  WAIT_DEADLINE_MS,
  at,
  listFrames,
  listInputs,
  readApprovalNotifications,
  reportEvent,
  spawnAgentWithGrants,
  waitForFrames,
  waitForSession,
  waitUntil,
  withAgentFleet,
  type Arranged,
} from "../sessions/testing";
import { buildFileTaskSource, createWorkflowOrFail } from "../workflows/testing";
import { runEffect } from "../daemon/testing";

/** Gives each case three wait deadlines, plus ten seconds for starting the fleet, the slow part of a session case. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** A well-formed UUIDv7 that matches no row on this controller. */
const ABSENT_ID = "0192f0a1-0000-7000-8000-00000000dead";

/** The session `insertOpenDecision` stamps as the producer of every decision it inserts. */
const INSERTED_PRODUCER = { type: "session", sessionId: "0199e0e7-5555-7000-8000-000000000000" };

/** Inserts an open decision with these answers, about the task `taskId`, and returns its id. */
const insertDecision = (
  harness: ServerHarness,
  taskId: string,
  actions: ReadonlyArray<BoundAction>,
): Promise<string> =>
  runEffect(
    Effect.provideService(
      insertOpenDecision({ kind: "task", id: taskId }, actions),
      SqlClient.SqlClient,
      harness.sql,
    ),
  );

/**
 * Runs one SQL statement on the controller's database. The rollback tests use
 * it to add a trigger, because no API call can land between the moment
 * `notification.act` reads the decision and the moment it resolves it.
 */
const executeSql = (harness: ServerHarness, statement: string): Promise<unknown> =>
  runEffect(harness.sql.unsafe(statement));

/**
 * Adds a trigger that resolves every open notification as withdrawn right
 * after a row is written to `table` with `event`. It stands in for a producer
 * that withdraws the decision while its answer's operation runs. In the tests
 * the withdrawal shares the operation's transaction, so it is rolled back
 * with everything else, and the tests check only what the operation wrote.
 */
const withdrawDecisionsOnWrite = (
  harness: ServerHarness,
  event: "INSERT" | "UPDATE",
  table: string,
): Promise<unknown> =>
  executeSql(
    harness,
    `CREATE TRIGGER withdraw_while_acting AFTER ${event} ON ${table}
     BEGIN
       UPDATE notifications
       SET status = 'resolved',
           resolution = '{"kind":"withdrawn","reason":"Withdrawn by the test.","actor":"user","origin":"core","at":"${at}"}'
       WHERE status = 'open';
     END`,
  );

/** Builds an answer that renames the task `taskId` to `title`. */
const buildRename = (taskId: string, title: string): BoundAction => ({
  id: "rename",
  label: "Rename",
  operation: { op: "task.update", input: { taskId, title } },
});

const DISMISS: BoundAction = { id: "dismiss", label: "Dismiss", operation: null };

const requestAct = (base: string, token: string, id: string, actionId: string) =>
  post(base, `/api/v1/notifications/${id}/act`, { actionId }, token);

/** Creates a task titled `title` and returns its id. Fails the test unless the create succeeds. */
const createTaskOrFail = async (base: string, token: string, title: string): Promise<string> => {
  const response = await post(base, "/api/v1/tasks", { title, description: "" }, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as Task).id;
};

const readTaskOrFail = async (base: string, token: string, id: string): Promise<Task> => {
  const response = await get(base, `/api/v1/tasks/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Task;
};

const readNotificationOrFail = async (
  base: string,
  token: string,
  id: string,
): Promise<Notification> => {
  const response = await get(base, `/api/v1/notifications/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Notification;
};

/** Takes an answer and returns the notification as `notification.act` returns it. Fails the test unless it succeeds. */
const actOrFail = async (
  base: string,
  token: string,
  id: string,
  actionId: string,
): Promise<Notification> => {
  const response = await requestAct(base, token, id, actionId);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Notification;
};

/** Mints an API key for the user and returns its token. */
const mintApiKeyOrFail = async (base: string, token: string): Promise<string> => {
  const response = await post(base, "/api/v1/api-keys", { name: "scripts" }, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { token: string }).token;
};

/**
 * Reports, as the runner, that the turn opened by a newly spawned agent's
 * prompt started and completed, at sequence numbers 2 and 3. Then waits until
 * the session is idle. The runner's next sequence number is 4.
 */
const finishFirstTurn = async (arranged: Arranged, session: Session): Promise<void> => {
  const base = { sessionId: session.id, at, turnId: "t1" };
  reportEvent(arranged.wire, 2, { ...base, eventId: crypto.randomUUID(), _tag: "turn.started" });
  reportEvent(arranged.wire, 3, {
    ...base,
    eventId: crypto.randomUUID(),
    _tag: "turn.completed",
    state: "completed",
  });
  await waitForSession(arranged, session.id, (one) => one.status === "idle");
};

/** Returns the texts of the input frames the controller has sent for a session. */
const listSentTexts = (arranged: Arranged, sessionId: string): ReadonlyArray<string> =>
  listFrames<SessionInput>(arranged.wire, "sessionInput")
    .filter((frame) => frame.sessionId === sessionId)
    .map((frame) => frame.input.text);

describe("taking an answer", () => {
  it("runs its operation as the user and resolves the decision, taken in the web app", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const token = await completeSetup(base);
      const taskId = await createTaskOrFail(base, token, "Fix the login page");
      const id = await insertDecision(harness, taskId, [buildRename(taskId, "Renamed"), DISMISS]);

      const returned = await actOrFail(base, token, id, "rename");

      expect(returned.status).toBe("resolved");
      expect(returned.resolution).toEqual({
        kind: "decided",
        actionId: "rename",
        actor: "user",
        origin: "web",
        at: returned.resolution!.at,
      });
      expect(await readNotificationOrFail(base, token, id)).toEqual(returned);
      expect((await readTaskOrFail(base, token, taskId)).title).toBe("Renamed");
      const entries = await harness.audit("notification.decided");
      expect(entries.map((entry) => [entry.actor, entry.payload])).toEqual([
        [
          "user",
          {
            notificationId: id,
            actionId: "rename",
            op: "task.update",
            producer: INSERTED_PRODUCER,
          },
        ],
      ]);
    });
  });

  it("records an answer taken with an API key as taken through the API", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const login = await completeSetup(base);
      const apiKey = await mintApiKeyOrFail(base, login);
      const taskId = await createTaskOrFail(base, login, "Fix the login page");
      const id = await insertDecision(harness, taskId, [buildRename(taskId, "Renamed")]);

      const returned = await actOrFail(base, apiKey, id, "rename");

      expect(returned.resolution).toMatchObject({ kind: "decided", actor: "user", origin: "api" });
      expect((await readTaskOrFail(base, login, taskId)).title).toBe("Renamed");
    });
  });

  it("only resolves the decision for an answer that runs nothing", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const token = await completeSetup(base);
      const taskId = await createTaskOrFail(base, token, "Fix the login page");
      const id = await insertDecision(harness, taskId, [buildRename(taskId, "Renamed"), DISMISS]);

      const returned = await actOrFail(base, token, id, "dismiss");

      expect(returned.resolution).toMatchObject({ kind: "decided", actionId: "dismiss" });
      expect((await readTaskOrFail(base, token, taskId)).title).toBe("Fix the login page");
      const entries = await harness.audit("notification.decided");
      expect(entries.map((entry) => entry.payload.op)).toEqual([null]);
    });
  });

  it("starts a run of the workflow an answer names", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const token = await completeSetup(base);
      const workflow = await createWorkflowOrFail(base, token, {
        source: buildFileTaskSource("Bugfix"),
      });
      const id = await insertDecision(harness, ABSENT_ID, [
        {
          id: "start",
          label: "Start a bugfix",
          operation: { op: "run.start", input: { workflowId: workflow.id } },
        },
      ]);

      const returned = await actOrFail(base, token, id, "start");

      expect(returned.resolution).toMatchObject({ kind: "decided", actionId: "start" });
      const runs = await get(base, `/api/v1/runs?workflowId=${workflow.id}`, token);
      expect(runs.status, await runs.clone().text()).toBe(200);
      expect(
        ((await runs.json()) as { readonly items: ReadonlyArray<unknown> }).items,
      ).toHaveLength(1);
    });
  });
});

describe("an answer that cannot be taken", () => {
  it("is refused once the decision is resolved, and runs nothing", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const token = await completeSetup(base);
      const taskId = await createTaskOrFail(base, token, "Fix the login page");
      const id = await insertDecision(harness, taskId, [buildRename(taskId, "Renamed"), DISMISS]);
      await actOrFail(base, token, id, "dismiss");

      const again = await requestAct(base, token, id, "rename");

      const refused = await readErrorBody(again);
      expect(again.status, refused.text).toBe(409);
      expect(refused.code).toBe("invalid_state");
      expect(refused.message).toMatch(/already resolved/);
      expect((await readTaskOrFail(base, token, taskId)).title).toBe("Fix the login page");
    });
  });

  it("returns the operation's own error when it fails, and leaves the decision open", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const token = await completeSetup(base);
      const id = await insertDecision(harness, ABSENT_ID, [buildRename(ABSENT_ID, "Renamed")]);

      const response = await requestAct(base, token, id, "rename");
      const refused = await readErrorBody(response);
      expect(response.status, refused.text).toBe(404);
      expect(refused.code).toBe("not_found");
      expect((await readNotificationOrFail(base, token, id)).status).toBe("open");
      expect(await harness.audit("notification.decided")).toEqual([]);
    });
  });

  it("is refused with a 404 naming the answers for an id the decision does not offer", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const token = await completeSetup(base);
      const id = await insertDecision(harness, ABSENT_ID, [DISMISS]);

      const response = await requestAct(base, token, id, "approve");
      const refused = await readErrorBody(response);
      expect(response.status, refused.text).toBe(404);
      expect(refused.code).toBe("not_found");
      expect(refused.message).toMatch(/"approve".*dismiss/);
    });
  });

  it("is refused with a 404 for a notification that does not exist", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);

      const response = await requestAct(harness.base, token, ABSENT_ID, "dismiss");

      const refused = await readErrorBody(response);
      expect(response.status, refused.text).toBe(404);
      expect(refused.code).toBe("not_found");
    });
  });

  it("is refused as a validation error when its stored operation no longer passes the check", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const token = await completeSetup(base);
      const taskId = await createTaskOrFail(base, token, "Fix the login page");
      const id = await insertDecision(harness, taskId, [
        {
          id: "delete",
          label: "Delete",
          operation: { op: "task.delete", input: { id: taskId } },
        },
      ]);

      const response = await requestAct(base, token, id, "delete");
      const refused = await readErrorBody(response);
      expect(response.status, refused.text).toBe(400);
      expect(refused.code).toBe("validation");
      expect(refused.issues).toEqual([["operation", "op"]]);
      expect((await readNotificationOrFail(base, token, id)).status).toBe("open");
      expect((await readTaskOrFail(base, token, taskId)).title).toBe("Fix the login page");
    });
  });

  it("rolls its operation back when the decision is withdrawn while the operation runs", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const token = await completeSetup(base);
      const taskId = await createTaskOrFail(base, token, "Fix the login page");
      const id = await insertDecision(harness, taskId, [buildRename(taskId, "Renamed")]);
      await withdrawDecisionsOnWrite(harness, "UPDATE", "tasks");

      const response = await requestAct(base, token, id, "rename");

      const refused = await readErrorBody(response);
      expect(response.status, refused.text).toBe(409);
      expect(refused.code).toBe("invalid_state");
      expect(refused.message).toMatch(/already resolved/);
      expect((await readTaskOrFail(base, token, taskId)).title).toBe("Fix the login page");
      expect(await harness.audit("notification.decided")).toEqual([]);
    });
  });

  it("is refused to a session, even one that holds notification.write", async () => {
    await withAgentFleet(async (arranged) => {
      const { harness, token } = arranged;
      const agent = await spawnAgentWithGrants(arranged, "notifiers", [
        "notification.read",
        "notification.write",
      ]);
      const id = await insertDecision(harness, ABSENT_ID, [DISMISS]);

      const response = await requestAct(harness.base, agent.token, id, "dismiss");
      const refused = await readErrorBody(response);
      expect(response.status, refused.text).toBe(403);
      expect(refused.code).toBe("forbidden");
      expect(refused.message).toMatch(/only the user/);
      expect((await readNotificationOrFail(harness.base, token, id)).status).toBe("open");
    });
  });
});

describe("an answer of the core's approval decision", () => {
  it("sends the answer to the runner and resolves the decision with it", async () => {
    await withAgentFleet(async (arranged) => {
      const { harness, token } = arranged;
      const { session } = await spawnAgentWithGrants(arranged, "workers", []);
      reportEvent(arranged.wire, 2, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "turn.started",
        turnId: "t1",
      });
      reportEvent(arranged.wire, 3, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "request.opened",
        request: {
          requestId: "req-1",
          itemId: "i1",
          kind: "command_approval",
          decisions: ["allow", "deny"],
          detail: { command: "ls -la" },
        },
      });
      const approval = await waitUntil("raised the approval decision", async () => {
        const [raised] = await readApprovalNotifications(arranged, session.id);
        return raised?.status === "open" ? raised : undefined;
      });

      const returned = await actOrFail(harness.base, token, approval.id, "allow");

      const [frame] = await waitForFrames<SessionRespond>(arranged.wire, "sessionRespond", 1);
      expect(frame).toMatchObject({ sessionId: session.id, requestId: "req-1", decision: "allow" });
      expect(returned.resolution).toMatchObject({
        kind: "decided",
        actionId: "allow",
        actor: "user",
        origin: "web",
      });
      expect(await harness.audit("notification.decided")).toHaveLength(1);
    });
  });
});

describe("an agent's question", () => {
  /** The answer an agent offers, which sends its text back to the agent's own session. */
  const buildReply = (id: string, text: string): BoundAction => ({
    id,
    label: text,
    operation: { op: "session.input", input: { sessionId: "me", text } },
  });

  /** Has the agent ask the user a question with two answers, and returns the decision's id. */
  const askQuestion = async (base: string, agentToken: string): Promise<string> => {
    const response = await post(
      base,
      "/api/v1/notifications",
      {
        kind: "agent.question",
        title: "Deploy to production?",
        actions: [buildReply("yes", "Yes, deploy it."), buildReply("no", "No, wait.")],
      },
      agentToken,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { notificationId: string }).notificationId;
  };

  it("stores the answer the user takes as input to the session that asked", async () => {
    await withAgentFleet(async (arranged) => {
      const { harness, token } = arranged;
      const agent = await spawnAgentWithGrants(arranged, "askers", [
        "notification.read",
        "notification.write",
      ]);
      const id = await askQuestion(harness.base, agent.token);

      const returned = await actOrFail(harness.base, token, id, "yes");

      expect(returned.resolution).toMatchObject({ kind: "decided", actionId: "yes" });
      expect(returned.actions[0]!.operation).toEqual({
        op: "session.input",
        input: { sessionId: agent.session.id, text: "Yes, deploy it." },
      });
      const inputs = await listInputs(arranged, agent.session.id);
      expect(inputs.map((input) => input.text)).toContain("Yes, deploy it.");
      expect(inputs.map((input) => input.text)).not.toContain("No, wait.");
    });
  });

  it("stores and sends nothing when the decision is withdrawn while the input is stored", async () => {
    await withAgentFleet(async (arranged) => {
      const { harness, token } = arranged;
      const agent = await spawnAgentWithGrants(arranged, "askers", [
        "notification.read",
        "notification.write",
      ]);
      // An idle session is sent its input as soon as the input commits, so
      // an input that was stored would show up as a frame.
      await finishFirstTurn(arranged, agent.session);
      const id = await askQuestion(harness.base, agent.token);
      await withdrawDecisionsOnWrite(harness, "INSERT", "session_inputs");

      const response = await requestAct(harness.base, token, id, "yes");

      const refused = await readErrorBody(response);
      expect(response.status, refused.text).toBe(409);
      expect(refused.message).toMatch(/already resolved/);
      expect(
        (await listInputs(arranged, agent.session.id)).map((input) => input.text),
      ).not.toContain("Yes, deploy it.");

      // With the trigger dropped, the same answer is stored and sent. This
      // shows that the missing frame above would have been sent if stored.
      await executeSql(harness, "DROP TRIGGER withdraw_while_acting");
      await actOrFail(harness.base, token, id, "yes");
      await waitUntil("sent the answer to the session", () =>
        listSentTexts(arranged, agent.session.id).includes("Yes, deploy it.") ? true : undefined,
      );
      // The prompt was sent first; the answer was sent once, by the second act.
      expect(listSentTexts(arranged, agent.session.id)).toEqual(["hello", "Yes, deploy it."]);
    });
  });
});
