/**
 * Tests the event pipeline's tick: what a pass reads, how far the cursor
 * moves, and what it writes for the routes that matched.
 *
 * Tests never call the pipeline directly. Its interval is shortened to a few
 * milliseconds, in the same loop `hercule serve` starts, and each test waits
 * for the tick's result.
 */
import { describe, expect, it, vi } from "vitest";
import type { Task } from "@hercule/contract";
import { post, send } from "../../http/testing";
import {
  buildCreateStep,
  buildHeldAction,
  requestCancel,
  RUN_WATCHER_GRANTS,
  startHeldRun,
  startRun,
  waitForRunToFinish,
  type HeldAction,
} from "../../runs/testing";
import {
  createProfile,
  at,
  spawnAgentWithGrants,
  waitUntil,
  WAIT_DEADLINE_MS,
  type Agent,
  type Arranged,
} from "../../sessions/testing";
import { createWorkflowOrFail } from "../../workflows/testing";
import {
  BURST,
  buildPayload,
  endPromptTurn,
  waitUntilCaughtUp,
  emitManualEvent,
  KIND,
  readMatchedInputRows,
  REF,
  waitForFrameCarrying,
  waitForMatchedInputRows,
  runEffect,
  storeCondition,
  subscribeAgent,
  spawnSubscriber,
  readCursorAndHead,
  withPipeline,
} from "../testing";

/** Long enough for a fleet, three sessions and several ticks. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 4 + 20_000 });

describe("the event pipeline's tick", () => {
  it("writes one matched input for a matched subscription, and moves its cursor past the event", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribeAgent(arranged, agent, REF);

      const eventId = await emitManualEvent(arranged, [REF], "The lid does not close");

      const rows = await waitForMatchedInputRows(
        arranged.harness,
        subscriptionId,
        (found) => found.length >= 1,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source).toBe("subscription");
      expect(rows[0]!.event_id).toBe(eventId);
      expect(rows[0]!.session).toBe(agent.session.id.replaceAll("-", ""));
      // `routing/render-event-input.test.ts` tests the exact text. This test
      // only checks that the row holds the rendered text, not the raw event.
      expect(rows[0]!.text).toContain(KIND);
      expect(rows[0]!.text).toContain("The lid does not close");
      expect(rows[0]!.text).toContain("```json");

      // The cursor ends at the end of the log. It is compared with the newest
      // event id rather than with this event's id, so an event appended by
      // something else in the meantime does not fail the test.
      const position = await waitUntilCaughtUp(arranged.harness);
      expect(position).toBeGreaterThanOrEqual(eventId);
    });
  });

  it("reads a burst larger than one batch to the end of the log in one tick, not one batch per tick", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "burst-holder");
      const subscriptionId = await subscribeAgent(arranged, agent, REF);
      await waitUntilCaughtUp(arranged.harness);

      // Two and a half batches, inserted in one statement so the router finds
      // them all at once, not a few per pass as they arrive. They are written
      // straight to the table because `event.emit` takes one call per event,
      // and the router would read the early ones while the later ones were
      // still being posted.
      await runEffect(
        arranged.harness.sql`
          INSERT INTO events
            (source, connection_id, system, kind, occurred_at, received_at,
             dedup_key, refs, url, payload, raw, actor)
          WITH RECURSIVE counted(value) AS (
            SELECT 1 UNION ALL SELECT value + 1 FROM counted WHERE value < ${BURST}
          )
          SELECT 'manual', NULL, 'github', ${KIND}, ${at}, ${at}, 'burst-' || value,
                 ${JSON.stringify([REF])}, NULL, ${JSON.stringify(buildPayload("a burst"))},
                 NULL, 'user'
          FROM counted`,
      );

      const rows = await waitForMatchedInputRows(
        arranged.harness,
        subscriptionId,
        (found) => found.length >= BURST,
      );
      expect(rows).toHaveLength(BURST);
      const seen = await readCursorAndHead(arranged.harness);
      expect(seen.position).toBe(seen.head);
    });
  });

  it("writes nothing twice, however often the cursor is moved back over the same events", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribeAgent(arranged, agent, REF);
      const eventId = await emitManualEvent(arranged, [REF], "The lid does not close");
      await waitForMatchedInputRows(arranged.harness, subscriptionId, (found) => found.length >= 1);
      const settled = await waitUntilCaughtUp(arranged.harness);

      // Simulates a crash between writing the matched inputs and moving the
      // cursor, three times.
      for (let pass = 0; pass < 3; pass++) {
        await runEffect(
          arranged.harness.sql`UPDATE event_cursors SET position = ${eventId - 1}
                               WHERE consumer = 'router'`,
        );
        await waitUntil("walked the log again", async () => {
          const seen = await readCursorAndHead(arranged.harness);
          return seen.position !== null && seen.position >= settled ? seen.position : undefined;
        });
        const rows = await readMatchedInputRows(arranged.harness, subscriptionId);
        expect(rows, `pass ${String(pass)}`).toHaveLength(1);
        expect(rows[0]!.event_id).toBe(eventId);
      }

      expect(await waitUntilCaughtUp(arranged.harness)).toBeGreaterThanOrEqual(settled);
    });
  });

  it("writes no matched input for an audit entry, whatever the condition, and moves the cursor past it", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribeAgent(arranged, agent, REF);
      // A condition that matches everything, so a missing row is caused by the
      // kind of event, not by the condition.
      await storeCondition(arranged.harness, subscriptionId, "true");

      // Creating a profile appends `profile.created`, which is an audit entry.
      await createProfile(arranged, "leaves-an-entry", ["event.read"]);
      const entries = await runEffect(
        arranged.harness.sql<{
          readonly id: number;
        }>`SELECT id FROM events WHERE kind = 'profile.created' ORDER BY id DESC LIMIT 1`,
      );
      const entryId = entries[0]!.id;

      await waitUntil("moved its cursor past the audit entry", async () => {
        const seen = await readCursorAndHead(arranged.harness);
        return seen.position !== null && seen.position >= entryId ? seen.position : undefined;
      });
      expect(await readMatchedInputRows(arranged.harness, subscriptionId)).toEqual([]);

      // The same subscription does get a row for a pipeline event, so the
      // missing row above is caused by the kind of event, not a stopped router.
      const eventId = await emitManualEvent(arranged, [REF], "The lid does not close");
      const rows = await waitForMatchedInputRows(
        arranged.harness,
        subscriptionId,
        (found) => found.length >= 1,
      );
      expect(rows.map((row) => row.event_id)).toEqual([eventId]);
    });
  });
});

/**
 * Runs `body` against `withPipeline`'s controller with the held action's
 * plugin installed too, so a test can keep a run running until it chooses how
 * the run ends. The held step is released however `body` ends, so a failed
 * test does not leave a run waiting.
 */
const withHeldRunPipeline = (
  held: HeldAction,
  body: (arranged: Arranged) => Promise<void>,
): Promise<void> =>
  withPipeline(
    async (arranged) => {
      try {
        await body(arranged);
      } finally {
        held.release();
      }
    },
    { additionalPlugins: [held.plugin] },
  );

/**
 * Spawns an idle session subscribed to the run, and returns it with its
 * subscription's id. The session is idle, so a matched input is delivered to
 * it at once.
 */
const subscribeIdleAgentToRun = async (
  arranged: Arranged,
  runId: string,
): Promise<{ readonly agent: Agent; readonly subscriptionId: string }> => {
  const agent = await spawnAgentWithGrants(arranged, "run-watchers", RUN_WATCHER_GRANTS);
  const response = await post(
    arranged.harness.base,
    "/api/v1/subscriptions",
    { target: { kind: "run", runId } },
    agent.token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const { subscriptionId } = (await response.json()) as { subscriptionId: string };
  await endPromptTurn(arranged, agent);
  return { agent, subscriptionId };
};

/**
 * The events the controller emits about its own state are pipeline events,
 * unlike audit entries: the router matches them against subscriptions.
 */
describe("the platform events in the pipeline", () => {
  it("writes a matched input for task.created and task.updated, in the order they happened", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribeAgent(arranged, agent, REF);
      // No target kind waits on a task yet, so the condition is written into
      // the row the router reads.
      await storeCondition(arranged.harness, subscriptionId, 'event.kind.startsWith("task.")');

      const created = await post(
        arranged.harness.base,
        "/api/v1/tasks",
        { title: "Fix the lid", description: "" },
        arranged.token,
      );
      expect(created.status, await created.clone().text()).toBe(200);
      const task = (await created.json()) as Task;
      const updated = await send("PATCH", arranged.harness.base, `/api/v1/tasks/${task.id}`, {
        body: { status: "done" },
        token: arranged.token,
      });
      expect(updated.status, await updated.clone().text()).toBe(200);

      const rows = await waitForMatchedInputRows(
        arranged.harness,
        subscriptionId,
        (found) => found.length >= 2,
      );
      const createdEvent = (await arranged.harness.platformEvents("task.created"))[0]!;
      const updatedEvent = (await arranged.harness.platformEvents("task.updated"))[0]!;
      expect(rows.map((row) => row.event_id)).toEqual([createdEvent.id, updatedEvent.id]);
      expect(rows[0]!.text).toContain("task.created");
      expect(rows[0]!.text).toContain(task.id);
      expect(rows[1]!.text).toContain("task.updated");
      expect(rows[1]!.text).toContain('"new": "done"');
    });
  });

  it("delivers a run's run.completed to the session subscribed to that run, and no other run's ending", async () => {
    const held = buildHeldAction();
    await withHeldRunPipeline(held, async (arranged) => {
      const base = arranged.harness.base;
      const runId = await startHeldRun(arranged.harness.base, arranged.token, held);
      const { agent, subscriptionId } = await subscribeIdleAgentToRun(arranged, runId);

      // Another run ends first. Its run.completed is in the log, and the
      // subscription must not match it.
      const other = await createWorkflowOrFail(base, arranged.token, {
        definition: { name: "One task", steps: [buildCreateStep("create")] },
      });
      const otherRunId = await startRun(base, arranged.token, other.id);
      expect((await waitForRunToFinish(base, arranged.token, otherRunId)).status).toBe("completed");

      held.release();
      expect((await waitForRunToFinish(base, arranged.token, runId)).status).toBe("completed");

      const frame = await waitForFrameCarrying(arranged, `"runId": "${runId}"`);
      expect(frame.sessionId).toBe(agent.session.id);
      expect(frame.input.text).toMatch(/^run\.completed\n/);
      const rows = await waitForMatchedInputRows(
        arranged.harness,
        subscriptionId,
        (found) => found[0]?.status === "delivered",
      );
      const ended = (await arranged.harness.platformEvents("run.completed")).find(
        (event) => event.payload["runId"] === runId,
      );
      expect(ended, "the run's run.completed").toBeDefined();
      // The run ended on its own, when its last step returned, so no one
      // ended it but the system.
      expect(ended!.actor).toBe("system");
      expect(rows.map((row) => row.event_id)).toEqual([ended!.id]);

      // The other run's ending was read by the router, and matched nothing.
      await waitUntilCaughtUp(arranged.harness);
      expect(await readMatchedInputRows(arranged.harness, subscriptionId)).toHaveLength(1);
    });
  });

  it("delivers run.cancelled to the session subscribed to a run the user cancels", async () => {
    const held = buildHeldAction();
    await withHeldRunPipeline(held, async (arranged) => {
      const base = arranged.harness.base;
      const runId = await startHeldRun(arranged.harness.base, arranged.token, held);
      const { agent, subscriptionId } = await subscribeIdleAgentToRun(arranged, runId);

      const response = await requestCancel(base, arranged.token, runId);
      expect(response.status, await response.clone().text()).toBe(200);

      const frame = await waitForFrameCarrying(arranged, `"runId": "${runId}"`);
      expect(frame.sessionId).toBe(agent.session.id);
      expect(frame.input.text).toMatch(/^run\.cancelled\n/);
      const cancelled = await arranged.harness.platformEvents("run.cancelled");
      expect(cancelled).toHaveLength(1);
      // The user's request ended the run, so the event carries the user.
      expect(cancelled[0]!.actor).toBe("user");
      const rows = await waitForMatchedInputRows(
        arranged.harness,
        subscriptionId,
        (found) => found[0]?.status === "delivered",
      );
      expect(rows.map((row) => row.event_id)).toEqual([cancelled[0]!.id]);
    });
  });
});
