/**
 * Integration tests for the no-double-fire rule of a failed run: when an
 * assistant's conversation holds a live subscription on the run, the
 * `core.run-failed` notification is recorded as already handled by that
 * conversation, and in every other case it is the ordinary notification.
 *
 * A held first step keeps the run running while the test writes the
 * subscription rows directly. Its second step fails once the test releases the
 * first, so the run fails with the subscriptions already in place. The
 * subscription rows carry a condition that never matches, so the event router
 * does not wake the holding session.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { Notification } from "@hercule/contract";
import { readDefaultConversation, startConversationSession } from "../conversations/testing";
import { runEffect } from "../daemon/testing";
import { get } from "../http/testing";
import { spawnThreadWithGrants, WAIT_DEADLINE_MS, type Arranged } from "../sessions/testing";
import { ABSENT_ID, createWorkflowOrFail } from "../workflows/testing";
import {
  buildHeldAction,
  buildHeldStep,
  RUN_WATCHER_GRANTS,
  startRun,
  waitForHeldExecutions,
  waitForRunToFinish,
  withRunFleet,
  type HeldAction,
} from "./testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

const toBlobHex = (id: string): string => id.replaceAll("-", "");

/** Writes a live subscription on a run, held by a session, that never matches an event. */
const insertRunSubscription = (
  arranged: Arranged,
  fields: { readonly sessionId: string; readonly runId: string; readonly createdAt: string },
): Promise<string> => {
  const id = crypto.randomUUID();
  return runEffect(
    arranged.harness.sql`
      INSERT INTO subscriptions (id, holder_kind, holder_id, target, condition, created_at, actor)
      VALUES (unhex(${toBlobHex(id)}), 'session', unhex(${toBlobHex(fields.sessionId)}),
              ${JSON.stringify({ kind: "run", runId: fields.runId })}, 'false',
              ${fields.createdAt}, ${`session:${fields.sessionId}`})`,
  ).then(() => id);
};

/** Ends a subscription the way `subscription.cancel` does. */
const endSubscription = (arranged: Arranged, id: string): Promise<void> =>
  runEffect(
    Effect.asVoid(
      arranged.harness.sql`
        UPDATE subscriptions SET ended_at = '2026-01-02T00:00:00.000Z', ended_reason = 'cancelled',
          ended_actor = 'user' WHERE id = unhex(${toBlobHex(id)})`,
    ),
  );

/** Marks a session as exited, and as rotated when `rotated` is true. It has no transcript to resume. */
const exitSession = (arranged: Arranged, sessionId: string, rotated: boolean): Promise<void> =>
  runEffect(
    Effect.asVoid(
      arranged.harness.sql`
        UPDATE sessions SET status = 'exited', native_session_id = NULL, token_hash = NULL,
          rotated_at = ${rotated ? "2026-01-02T00:00:00.000Z" : null}
        WHERE id = unhex(${toBlobHex(sessionId)})`,
    ),
  );

/** Starts a run that holds at `first` and then fails at `update`, and returns its id. */
const startRunThatFailsAfterHold = async (
  arranged: Arranged,
  held: HeldAction,
): Promise<string> => {
  const base = arranged.harness.base;
  const workflow = await createWorkflowOrFail(base, arranged.token, {
    definition: {
      name: "Hold then fail",
      steps: [
        buildHeldStep(held, "first"),
        {
          id: "update",
          kind: "action",
          action: "task.update",
          params: { taskId: ABSENT_ID, status: "done" },
        },
      ],
      edges: [{ from: "first", to: "update" }],
    },
  });
  const runId = await startRun(base, arranged.token, workflow.id);
  await waitForHeldExecutions(held, 1);
  return runId;
};

/** Lets the held run go on to its failing step, and returns the run's failure notifications. */
const failRun = async (
  arranged: Arranged,
  held: HeldAction,
  runId: string,
): Promise<ReadonlyArray<Notification>> => {
  held.release();
  const run = await waitForRunToFinish(arranged.harness.base, arranged.token, runId);
  expect(run.status).toBe("failed");
  const response = await get(arranged.harness.base, "/api/v1/notifications", arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  const { items } = (await response.json()) as { readonly items: ReadonlyArray<Notification> };
  return items.filter((one) => one.kind === "core.run-failed");
};

describe("a failed run watched by an assistant's conversation", () => {
  it("records its core.run-failed notification as handled by the conversation, once", async () => {
    const held = buildHeldAction();
    await withRunFleet(
      async (arranged) => {
        const { conversation } = await readDefaultConversation(arranged);
        const session = await startConversationSession(arranged, conversation.id, "hello");
        const runId = await startRunThatFailsAfterHold(arranged, held);
        await insertRunSubscription(arranged, {
          sessionId: session.id,
          runId,
          createdAt: "2026-01-01T00:00:00.000Z",
        });

        const notifications = await failRun(arranged, held, runId);

        expect(notifications).toEqual([
          expect.objectContaining({
            status: "resolved",
            actions: [],
            resolution: {
              kind: "handled",
              actor: "system",
              origin: "core",
              conversationId: conversation.id,
              at: expect.any(String) as unknown,
            },
          }),
        ]);
      },
      [held.plugin],
    );
  });

  it("records an ordinary notification, with no resolution, when only a thread watches the run", async () => {
    const held = buildHeldAction();
    await withRunFleet(
      async (arranged) => {
        const thread = await spawnThreadWithGrants(arranged, "run-watchers", RUN_WATCHER_GRANTS);
        const runId = await startRunThatFailsAfterHold(arranged, held);
        await insertRunSubscription(arranged, {
          sessionId: thread.session.id,
          runId,
          createdAt: "2026-01-01T00:00:00.000Z",
        });

        const notifications = await failRun(arranged, held, runId);

        expect(notifications).toHaveLength(1);
        expect(notifications[0]).not.toHaveProperty("resolution");
      },
      [held.plugin],
    );
  });

  it("records an ordinary notification when the conversation's subscription was cancelled", async () => {
    const held = buildHeldAction();
    await withRunFleet(
      async (arranged) => {
        const { conversation } = await readDefaultConversation(arranged);
        const session = await startConversationSession(arranged, conversation.id, "hello");
        const runId = await startRunThatFailsAfterHold(arranged, held);
        const subscriptionId = await insertRunSubscription(arranged, {
          sessionId: session.id,
          runId,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        await endSubscription(arranged, subscriptionId);

        const notifications = await failRun(arranged, held, runId);

        expect(notifications).toHaveLength(1);
        expect(notifications[0]).not.toHaveProperty("resolution");
      },
      [held.plugin],
    );
  });

  it("records an ordinary notification when the subscription's session has exited for good", async () => {
    const held = buildHeldAction();
    await withRunFleet(
      async (arranged) => {
        const { conversation } = await readDefaultConversation(arranged);
        const session = await startConversationSession(arranged, conversation.id, "hello");
        const runId = await startRunThatFailsAfterHold(arranged, held);
        await insertRunSubscription(arranged, {
          sessionId: session.id,
          runId,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        await exitSession(arranged, session.id, false);

        const notifications = await failRun(arranged, held, runId);

        expect(notifications).toHaveLength(1);
        expect(notifications[0]).not.toHaveProperty("resolution");
      },
      [held.plugin],
    );
  });

  it("records it as handled when the subscription's session was rotated and the conversation goes on", async () => {
    const held = buildHeldAction();
    await withRunFleet(
      async (arranged) => {
        const { conversation } = await readDefaultConversation(arranged);
        const session = await startConversationSession(arranged, conversation.id, "hello");
        const runId = await startRunThatFailsAfterHold(arranged, held);
        await insertRunSubscription(arranged, {
          sessionId: session.id,
          runId,
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        await exitSession(arranged, session.id, true);

        const notifications = await failRun(arranged, held, runId);

        expect(notifications).toHaveLength(1);
        expect(notifications[0]).toHaveProperty("resolution.conversationId", conversation.id);
      },
      [held.plugin],
    );
  });
});
