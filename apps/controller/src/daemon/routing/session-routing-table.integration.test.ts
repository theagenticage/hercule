/**
 * The session routing table, running: the sweep of subscriptions nobody holds
 * any more, and what a condition that cannot be evaluated does to the
 * subscription it belongs to.
 *
 * Everything here goes through the whole pipeline, because a match is only a
 * match when the row it wrote reaches the session that was waiting for it.
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

/** A fleet, three sessions and several ticks fit inside this. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 4 + 20_000 });

describe("the session routing table's sweep", () => {
  it("ends only the subscription whose holder is past resuming, and matches for the other two", async () => {
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
      // Nobody asked for this end, so the stamp is the system's own.
      expect(ended.ended_actor).toBe("system");

      // A restart changes nothing: a subscription does not end because a
      // process exited.
      await arranged.harness.reboot();

      await emitManualEvent(arranged, [REF], "after the sweep");

      expect((await readSubscriptionRow(arranged.harness, live))!.ended_at).toBeNull();
      expect((await readSubscriptionRow(arranged.harness, sleeping))!.ended_at).toBeNull();
      // The idle holder is woken, and the resumable one is told to start again.
      await waitForFrameCarrying(arranged, "after the sweep");
      await waitForMatchedInputRows(arranged.harness, live, (rows) => rows.length >= 1);
      await waitForMatchedInputRows(arranged.harness, sleeping, (rows) => rows.length >= 1);
      await waitForStartFrames(arranged, resumable.session.id, 2);
      expect(await readMatchedInputRows(arranged.harness, doomed)).toEqual([]);
    });
  });

  it("calls off an input still waiting for the holder it can no longer reach, with the same reason", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "resumable-holder");
      const subscriptionId = await subscribeAgent(arranged, agent, REF);
      await exitSession(arranged, agent, 2);
      expect((await readSession(arranged, agent.session.id)).resumable).toBe(true);

      // A row a match wrote and nothing has delivered yet: what a crash
      // between the matched input's commit and its delivery leaves behind.
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

      // The machine is retired, so the transcript can no longer be picked up
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
  it("reports it once per error, keeps the subscription live, and goes quiet again when it is clean", async () => {
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

        // A second failing evaluation refreshes the message and says nothing.
        const second = await emitManualEvent(arranged, [REF], "the second failure");
        await waitUntil("walked past the second event", async () => {
          const seen = await readCursorAndHead(arranged.harness);
          return seen.position !== null && seen.position >= second ? seen.position : undefined;
        });
        expect(await readMatchedInputRows(arranged.harness, subscriptionId)).toEqual([]);
        expect(calls.filter((call) => call.subscriptionId === subscriptionId)).toHaveLength(1);
        expect(calls[0]!.message).toBe(failed.message);

        // A clean evaluation returns the health to ok, and says nothing.
        await storeCondition(arranged.harness, subscriptionId, "true");
        await emitManualEvent(arranged, [REF], "the clean one");
        await waitForHealth(arranged, agent, subscriptionId, (health) => health.state === "ok");
        expect(calls.filter((call) => call.subscriptionId === subscriptionId)).toHaveLength(1);

        // The next failure is a new error, and is reported again.
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

  it("is a no-match for that subscription alone: every other one is still evaluated and delivered", async () => {
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

  it("is a no-match when it reads the original payload, which the context does not carry", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "raw-reader");
      const subscriptionId = await subscribeAgent(arranged, agent, REF);
      await storeCondition(arranged.harness, subscriptionId, READS_RAW);

      const eventId = await emitManualEvent(arranged, [REF], "not for a reader of raw");

      // Reading `raw` fails; it does not answer that there is none. A context
      // carrying the field would make this condition a plain false, and the
      // subscription's health would stay ok.
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

  it("treats an evaluation over the wall-clock budget as a no-match, and says so on the subscription", async () => {
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
      // Every evaluation on this controller is over budget, which is the only
      // lever there is: the evaluator offers no timeout and no fuel. A budget
      // of zero is the one that holds whatever the clock does, because an
      // evaluation that reaches its budget is over it; a budget a real
      // evaluation can stay under would leave nothing to report.
      { expressionBudget: Duration.zero },
    );
  });
});
