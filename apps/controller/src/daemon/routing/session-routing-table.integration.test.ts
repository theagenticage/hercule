/**
 * Tests the session routing table: the sweep that ends subscriptions whose
 * holder is gone, and what a condition that fails to evaluate does to its
 * subscription.
 *
 * Every test goes through the whole pipeline, because a match only counts
 * when the row it wrote reaches the session waiting for it.
 */
import { describe, expect, it, vi } from "vitest";
import { Duration } from "effect";
import {
  at,
  readSession,
  waitForStartFrames,
  waitUntil,
  WAIT_DEADLINE_MS,
} from "../../sessions/testing";
import {
  waitUntilCaughtUp,
  emitManualEvent,
  exitSession,
  waitForFrameCarrying,
  waitForHealth,
  readMatchedInputRows,
  READS_RAW,
  buildRecordingNotifier,
  REF,
  waitForMatchedInputRows,
  runEffect,
  storeCondition,
  spawnStrandedAgent,
  STRANDED_INPUT_ID,
  subscribeAgent,
  spawnSubscriber,
  readSubscriptionRow,
  UNKNOWN_FUNCTION,
  UNRESOLVABLE,
  readCursorAndHead,
  withPipeline,
  type Notified,
} from "../testing";

/** Long enough for a fleet, three sessions and several ticks. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 4 + 20_000 });

describe("the session routing table's sweep", () => {
  it("ends only the subscription whose holder cannot be resumed, and matches for the other two", async () => {
    await withPipeline(async (arranged) => {
      const idle = await spawnSubscriber(arranged, "idle-holder");
      const resumable = await spawnSubscriber(arranged, "resumable-holder");
      const gone = await spawnStrandedAgent(arranged, "gone-holder");

      const live = await subscribeAgent(arranged, idle, REF);
      const sleeping = await subscribeAgent(arranged, resumable, REF);
      const doomed = await subscribeAgent(arranged, gone, REF);

      await exitSession(arranged, resumable, 2);
      expect((await readSession(arranged, resumable.session.id)).resumable).toBe(true);
      await exitSession(arranged, gone, 1);
      expect((await readSession(arranged, gone.session.id)).resumable).toBe(false);

      const ended = await waitUntil("ended the subscription whose holder is gone", async () => {
        const row = await readSubscriptionRow(arranged.harness, doomed);
        return row?.ended_at === null ? undefined : row;
      });
      expect(ended.ended_reason, "the reason names the holder that ended").toMatch(/session/i);
      expect(ended.ended_reason).toContain(gone.session.id);
      // No user or session asked for this end, so the system is the actor.
      expect(ended.ended_actor).toBe("system");

      // A process that exited but can be resumed does not end its
      // subscription.
      await arranged.harness.reboot();

      await emitManualEvent(arranged, [REF], "after the sweep");

      expect((await readSubscriptionRow(arranged.harness, live))!.ended_at).toBeNull();
      expect((await readSubscriptionRow(arranged.harness, sleeping))!.ended_at).toBeNull();
      // The idle holder is woken, and the runner is told to restart the
      // resumable one.
      await waitForFrameCarrying(arranged, "after the sweep");
      await waitForMatchedInputRows(arranged.harness, live, (rows) => rows.length >= 1);
      await waitForMatchedInputRows(arranged.harness, sleeping, (rows) => rows.length >= 1);
      await waitForStartFrames(arranged, resumable.session.id, 2);
      expect(await readMatchedInputRows(arranged.harness, doomed)).toEqual([]);
    });
  });

  it("cancels an input still waiting for a holder that has ended, with the same reason", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "resumable-holder");
      const subscriptionId = await subscribeAgent(arranged, agent, REF);
      await exitSession(arranged, agent, 2);
      expect((await readSession(arranged, agent.session.id)).resumable).toBe(true);

      // A matched input that was never delivered, as a crash between its
      // commit and its delivery would leave behind.
      const eventId = await emitManualEvent(arranged, [REF], "never delivered");
      await runEffect(
        arranged.harness.sql`
          INSERT INTO session_inputs
            (id, session_id, source, actor, text, status, created_at, subscription_id, event_id)
          VALUES
            (unhex(replace(${STRANDED_INPUT_ID}, '-', '')),
             unhex(replace(${agent.session.id}, '-', '')),
             'subscription', 'system', 'never delivered', 'queued', ${at},
             unhex(replace(${subscriptionId}, '-', '')), ${eventId + 1000})`,
      );

      // The runner is retired, so the transcript can no longer be resumed,
      // and the holder has ended for good.
      await runEffect(
        arranged.harness.sql`UPDATE runners SET lifecycle = 'retired'
                             WHERE id = unhex(replace(${arranged.runnerId}, '-', ''))`,
      );

      const ended = await waitUntil("ended the subscription", async () => {
        const row = await readSubscriptionRow(arranged.harness, subscriptionId);
        return row?.ended_at === null ? undefined : row;
      });
      const rows = await waitForMatchedInputRows(arranged.harness, subscriptionId, (found) =>
        found.every((row) => row.status !== "queued"),
      );
      const waiting = rows.find((row) => row.text === "never delivered");
      expect(waiting, "the row that was still waiting").toBeDefined();
      expect(waiting!.status).toBe("cancelled");
      expect(waiting!.reason).toBe(ended.ended_reason);
    });
  });
});

describe("a condition the router cannot evaluate", () => {
  it("is reported once per error, keeps the subscription live, and is cleared by a clean evaluation", async () => {
    const calls: Array<Notified> = [];
    await withPipeline(
      async (arranged) => {
        const agent = await spawnSubscriber(arranged, "subscribers");
        const subscriptionId = await subscribeAgent(arranged, agent, REF);
        await storeCondition(arranged.harness, subscriptionId, UNRESOLVABLE);

        await emitManualEvent(arranged, [REF], "the first failure");
        const failed = await waitForHealth(
          arranged,
          agent,
          subscriptionId,
          (health) => health.state === "error",
        );
        expect(failed.message ?? "").not.toBe("");
        expect(failed.at ?? "").not.toBe("");

        // A second failed evaluation updates the message and sends no
        // notification.
        const second = await emitManualEvent(arranged, [REF], "the second failure");
        await waitUntil("walked past the second event", async () => {
          const seen = await readCursorAndHead(arranged.harness);
          return seen.position !== null && seen.position >= second ? seen.position : undefined;
        });
        expect(await readMatchedInputRows(arranged.harness, subscriptionId)).toEqual([]);
        expect(calls.filter((call) => call.subscriptionId === subscriptionId)).toHaveLength(1);
        expect(calls[0]!.message).toBe(failed.message);

        // A clean evaluation sets the health back to ok, and sends no
        // notification.
        await storeCondition(arranged.harness, subscriptionId, "true");
        await emitManualEvent(arranged, [REF], "the clean one");
        await waitForHealth(arranged, agent, subscriptionId, (health) => health.state === "ok");
        expect(calls.filter((call) => call.subscriptionId === subscriptionId)).toHaveLength(1);

        // The next failure is a new error, and is notified again.
        await storeCondition(arranged.harness, subscriptionId, UNRESOLVABLE);
        await emitManualEvent(arranged, [REF], "the new error");
        await waitForHealth(arranged, agent, subscriptionId, (health) => health.state === "error");
        await waitUntil("reported the new error", () =>
          calls.filter((call) => call.subscriptionId === subscriptionId).length === 2
            ? calls
            : undefined,
        );
        expect(calls.filter((call) => call.subscriptionId === subscriptionId)).toHaveLength(2);
      },
      { evaluationErrorNotifier: buildRecordingNotifier(calls) },
    );
  });

  it("counts as no match for that subscription only, and every other one is still evaluated and delivered", async () => {
    await withPipeline(async (arranged) => {
      const broken = await spawnSubscriber(arranged, "broken-holder");
      const sound = await spawnSubscriber(arranged, "sound-holder");
      const failing = await subscribeAgent(arranged, broken, REF);
      const working = await subscribeAgent(arranged, sound, REF);
      await storeCondition(arranged.harness, failing, UNKNOWN_FUNCTION);

      const eventId = await emitManualEvent(arranged, [REF], "still delivered");

      const rows = await waitForMatchedInputRows(
        arranged.harness,
        working,
        (found) => found.length >= 1,
      );
      expect(rows[0]!.event_id).toBe(eventId);
      await waitForFrameCarrying(arranged, "still delivered");
      expect(await readMatchedInputRows(arranged.harness, failing)).toEqual([]);
      const health = await waitForHealth(arranged, broken, failing, (one) => one.state === "error");
      expect(health.message ?? "").toContain("shout");
      expect(await waitUntilCaughtUp(arranged.harness)).toBeGreaterThanOrEqual(eventId);
    });
  });

  it("counts as no match when it reads the raw payload, which the context leaves out", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "raw-reader");
      const subscriptionId = await subscribeAgent(arranged, agent, REF);
      await storeCondition(arranged.harness, subscriptionId, READS_RAW);

      const eventId = await emitManualEvent(arranged, [REF], "not for a reader of raw");

      // Reading `raw` fails, rather than returning null. If the context had
      // the field, this condition would simply be false, and the health
      // would stay ok.
      const health = await waitForHealth(
        arranged,
        agent,
        subscriptionId,
        (one) => one.state === "error",
      );
      expect(health.message ?? "").toContain("raw");
      expect(await readMatchedInputRows(arranged.harness, subscriptionId)).toEqual([]);
      expect(await waitUntilCaughtUp(arranged.harness)).toBeGreaterThanOrEqual(eventId);
    });
  });

  it("treats an evaluation over the time budget as no match, and records the error on the subscription", async () => {
    await withPipeline(
      async (arranged) => {
        const agent = await spawnSubscriber(arranged, "subscribers");
        const subscriptionId = await subscribeAgent(arranged, agent, REF);

        const eventId = await emitManualEvent(arranged, [REF], "over budget");

        const health = await waitForHealth(
          arranged,
          agent,
          subscriptionId,
          (one) => one.state === "error",
        );
        expect(health.message ?? "").toContain("budget");
        expect(await readMatchedInputRows(arranged.harness, subscriptionId)).toEqual([]);
        expect(await waitUntilCaughtUp(arranged.harness)).toBeGreaterThanOrEqual(eventId);
      },
      // With a budget of zero, every evaluation on this controller is over
      // budget. That is the only way to force it, because the evaluator has
      // no timeout or step limit. Zero works whatever the clock does, because
      // an evaluation that reaches its budget counts as over it. Any budget a
      // real evaluation could stay under would leave nothing to report.
      { expressionBudget: Duration.zero },
    );
  });
});
