/**
 * The session routing table, running: the sweep of subscriptions nobody holds
 * any more, the delivery of the rows a match wrote, and what a condition that
 * cannot be evaluated does to the subscription it belongs to.
 *
 * Everything here goes through the whole pipeline, because a delivery is only
 * a delivery when a frame crosses the runner socket.
 */
import { describe, expect, it, vi } from "vitest";
import { Duration } from "effect";
import {
  at,
  readSession,
  report,
  startFrames,
  until,
  WAIT_DEADLINE_MS,
} from "../../sessions/testing";
import {
  caughtUp,
  emitted,
  exit,
  frameWhen,
  healthWhen,
  inputFrames,
  madeBusy,
  matchedInputRows,
  READS_RAW,
  buildRecordingNotifier,
  REF,
  rowsWhen,
  runEffect,
  sentFrames,
  storeCondition,
  spawnStrandedAgent,
  STRANDED_INPUT_ID,
  subscribed,
  spawnSubscriber,
  subscriptionRow,
  turnCompleted,
  UNKNOWN_FUNCTION,
  UNRESOLVABLE,
  readCursorAndHead,
  waitOutSeveralTicks,
  withPipeline,
  type Notified,
} from "../testing";

/** A fleet, three sessions and several ticks fit inside this. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 4 + 20_000 });

describe("the delivery of a matched input", () => {
  it("delivers to an idle session at once", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribed(arranged, agent, REF);
      expect((await readSession(arranged, agent.session.id)).status).toBe("idle");

      await emitted(arranged, [REF], "delivered at once");

      const frame = await frameWhen(arranged, "delivered at once");
      expect(frame.sessionId).toBe(agent.session.id);
      const rows = await rowsWhen(
        arranged.harness,
        subscriptionId,
        (found) => found[0]?.status === "delivered",
      );
      expect(rows[0]!.status).toBe("delivered");
    });
  });

  it("keeps a busy session's rows waiting, and sends the oldest first at the boundary", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribed(arranged, agent, REF);
      await madeBusy(arranged, agent, 2);

      await emitted(arranged, [REF], "the older one");
      await emitted(arranged, [REF], "the newer one");
      const waiting = await rowsWhen(
        arranged.harness,
        subscriptionId,
        (found) => found.length >= 2,
      );
      expect(waiting.map((row) => row.status)).toEqual(["queued", "queued"]);
      // Neither row crosses the socket while the turn runs, however many ticks
      // the pipeline makes in the meantime.
      await waitOutSeveralTicks();
      expect(sentFrames(arranged, "the older one")).toEqual([]);
      expect(sentFrames(arranged, "the newer one")).toEqual([]);

      // The boundary releases them, oldest first.
      turnCompleted(arranged, agent.session.id, 3);
      await frameWhen(arranged, "the newer one");
      const sent = inputFrames(arranged).map((frame) => frame.input.text);
      expect(sent.findIndex((text) => text.includes("the older one"))).toBeLessThan(
        sent.findIndex((text) => text.includes("the newer one")),
      );
      const rows = await rowsWhen(arranged.harness, subscriptionId, (found) =>
        found.every((row) => row.status === "delivered"),
      );
      expect(rows.map((row) => row.text.includes("the older one"))).toEqual([true, false]);
    });
  });

  it("sends no second row while the first is on the wire and unanswered", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribed(arranged, agent, REF);
      // The machine takes the frame and says nothing about it, so the turn it
      // opened has not started as far as the controller knows.
      arranged.wire.answering(() => undefined);

      await emitted(arranged, [REF], "the older one");
      await emitted(arranged, [REF], "the newer one");
      await rowsWhen(arranged.harness, subscriptionId, (found) => found.length >= 2);

      // The oldest row goes out, and the newer one stays behind it however
      // many ticks pass: the runner takes one input per turn boundary, and a
      // second row sent now is a row it has to hold.
      await frameWhen(arranged, "the older one");
      await waitOutSeveralTicks();
      expect(sentFrames(arranged, "the newer one")).toEqual([]);

      // The machine answers at last, which is what lets the next row go.
      arranged.wire.release("opened");
      await frameWhen(arranged, "the newer one");
    });
  });

  it("resumes a session whose harness is gone but whose transcript is not, and opens its turn with the row", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribed(arranged, agent, REF);
      await exit(arranged, agent, 2);
      const ended = await readSession(arranged, agent.session.id);
      expect(ended.status).toBe("exited");
      expect(ended.resumable).toBe(true);

      await emitted(arranged, [REF], "wake up");

      // The session is told to start again, on its own native session.
      const starts = await startFrames(arranged, agent.session.id, 2);
      expect(starts[1]!.spec.continue).toMatchObject({ mode: "resume" });
      await rowsWhen(arranged.harness, subscriptionId, (found) => found.length >= 1);

      // The resumed harness reports it is up, and the turn opens with the row.
      report(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: agent.session.id,
        at,
        _tag: "session.started",
        providerRefs: { nativeSessionId: "native-1" },
      });
      const frame = await frameWhen(arranged, "wake up");
      expect(frame.sessionId).toBe(agent.session.id);
    });
  });
});

describe("the session routing table's sweep", () => {
  it("ends only the subscription whose holder is past resuming, and matches for the other two", async () => {
    await withPipeline(async (arranged) => {
      const idle = await spawnSubscriber(arranged, "idle-holder");
      const resumable = await spawnSubscriber(arranged, "resumable-holder");
      const gone = await spawnStrandedAgent(arranged, "gone-holder");

      const live = await subscribed(arranged, idle, REF);
      const sleeping = await subscribed(arranged, resumable, REF);
      const doomed = await subscribed(arranged, gone, REF);

      await exit(arranged, resumable, 2);
      expect((await readSession(arranged, resumable.session.id)).resumable).toBe(true);
      await exit(arranged, gone, 1);
      expect((await readSession(arranged, gone.session.id)).resumable).toBe(false);

      const ended = await until("ended the subscription whose holder is gone", async () => {
        const row = await subscriptionRow(arranged.harness, doomed);
        return row?.ended_at === null ? undefined : row;
      });
      expect(ended.ended_reason, "the reason names the holder that ended").toMatch(/session/i);
      expect(ended.ended_reason).toContain(gone.session.id);
      // Nobody asked for this end, so the stamp is the system's own.
      expect(ended.ended_actor).toBe("system");

      // A restart changes nothing: a subscription does not end because a
      // process exited.
      await arranged.harness.reboot();

      await emitted(arranged, [REF], "after the sweep");

      expect((await subscriptionRow(arranged.harness, live))!.ended_at).toBeNull();
      expect((await subscriptionRow(arranged.harness, sleeping))!.ended_at).toBeNull();
      // The idle holder is woken, and the resumable one is told to start again.
      await frameWhen(arranged, "after the sweep");
      await rowsWhen(arranged.harness, live, (rows) => rows.length >= 1);
      await rowsWhen(arranged.harness, sleeping, (rows) => rows.length >= 1);
      await startFrames(arranged, resumable.session.id, 2);
      expect(await matchedInputRows(arranged.harness, doomed)).toEqual([]);
    });
  });

  it("calls off an input still waiting for the holder it can no longer reach, with the same reason", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "resumable-holder");
      const subscriptionId = await subscribed(arranged, agent, REF);
      await exit(arranged, agent, 2);
      expect((await readSession(arranged, agent.session.id)).resumable).toBe(true);

      // A row a match wrote and nothing has delivered yet: what a crash
      // between the matched input's commit and its delivery leaves behind.
      const eventId = await emitted(arranged, [REF], "never delivered");
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

      const ended = await until("ended the subscription", async () => {
        const row = await subscriptionRow(arranged.harness, subscriptionId);
        return row?.ended_at === null ? undefined : row;
      });
      const rows = await rowsWhen(arranged.harness, subscriptionId, (found) =>
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
        const subscriptionId = await subscribed(arranged, agent, REF);
        await storeCondition(arranged.harness, subscriptionId, UNRESOLVABLE);

        await emitted(arranged, [REF], "the first failure");
        const failed = await healthWhen(
          arranged,
          agent,
          subscriptionId,
          (health) => health.state === "error",
        );
        expect(failed.message ?? "").not.toBe("");
        expect(failed.at ?? "").not.toBe("");

        // A second failing evaluation refreshes the message and says nothing.
        const second = await emitted(arranged, [REF], "the second failure");
        await until("walked past the second event", async () => {
          const seen = await readCursorAndHead(arranged.harness);
          return seen.position !== null && seen.position >= second ? seen.position : undefined;
        });
        expect(await matchedInputRows(arranged.harness, subscriptionId)).toEqual([]);
        expect(calls.filter((call) => call.subscriptionId === subscriptionId)).toHaveLength(1);
        expect(calls[0]!.message).toBe(failed.message);

        // A clean evaluation returns the health to ok, and says nothing.
        await storeCondition(arranged.harness, subscriptionId, "true");
        await emitted(arranged, [REF], "the clean one");
        await healthWhen(arranged, agent, subscriptionId, (health) => health.state === "ok");
        expect(calls.filter((call) => call.subscriptionId === subscriptionId)).toHaveLength(1);

        // The next failure is a new error, and is reported again.
        await storeCondition(arranged.harness, subscriptionId, UNRESOLVABLE);
        await emitted(arranged, [REF], "the new error");
        await healthWhen(arranged, agent, subscriptionId, (health) => health.state === "error");
        await until("reported the new error", () =>
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
      const failing = await subscribed(arranged, broken, REF);
      const working = await subscribed(arranged, sound, REF);
      await storeCondition(arranged.harness, failing, UNKNOWN_FUNCTION);

      const eventId = await emitted(arranged, [REF], "still delivered");

      const rows = await rowsWhen(arranged.harness, working, (found) => found.length >= 1);
      expect(rows[0]!.event_id).toBe(eventId);
      await frameWhen(arranged, "still delivered");
      expect(await matchedInputRows(arranged.harness, failing)).toEqual([]);
      const health = await healthWhen(arranged, broken, failing, (one) => one.state === "error");
      expect(health.message ?? "").toContain("shout");
      expect(await caughtUp(arranged.harness)).toBeGreaterThanOrEqual(eventId);
    });
  });

  it("is a no-match when it reads the original payload, which the context does not carry", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "raw-reader");
      const subscriptionId = await subscribed(arranged, agent, REF);
      await storeCondition(arranged.harness, subscriptionId, READS_RAW);

      const eventId = await emitted(arranged, [REF], "not for a reader of raw");

      // Reading `raw` fails; it does not answer that there is none. A context
      // carrying the field would make this condition a plain false, and the
      // subscription's health would stay ok.
      const health = await healthWhen(
        arranged,
        agent,
        subscriptionId,
        (one) => one.state === "error",
      );
      expect(health.message ?? "").toContain("raw");
      expect(await matchedInputRows(arranged.harness, subscriptionId)).toEqual([]);
      expect(await caughtUp(arranged.harness)).toBeGreaterThanOrEqual(eventId);
    });
  });

  it("treats an evaluation over the wall-clock budget as a no-match, and says so on the subscription", async () => {
    await withPipeline(
      async (arranged) => {
        const agent = await spawnSubscriber(arranged, "subscribers");
        const subscriptionId = await subscribed(arranged, agent, REF);

        const eventId = await emitted(arranged, [REF], "over budget");

        const health = await healthWhen(
          arranged,
          agent,
          subscriptionId,
          (one) => one.state === "error",
        );
        expect(health.message ?? "").toContain("budget");
        expect(await matchedInputRows(arranged.harness, subscriptionId)).toEqual([]);
        expect(await caughtUp(arranged.harness)).toBeGreaterThanOrEqual(eventId);
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
