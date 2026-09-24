/**
 * The delivery of a queued input, running: what an idle, a busy, an exited and
 * a stalled session each do with a row that is waiting for them.
 *
 * Everything here goes through the whole pipeline, because a delivery is only
 * a delivery when a frame crosses the runner socket. The rows are written both
 * ways a row is written - by a match, and by a person typing - because the
 * delivery reads them without asking which.
 */
import { describe, expect, it, vi } from "vitest";
import {
  at,
  readSession,
  reportEvent,
  waitForStartFrames,
  WAIT_DEADLINE_MS,
} from "../../sessions/testing";
import { post } from "../../http/testing";
import {
  emitManualEvent,
  exitSession,
  waitForFrameCarrying,
  listInputFrames,
  makeBusy,
  REF,
  waitForMatchedInputRows,
  runEffect,
  listFramesCarrying,
  spawnSubscriber,
  subscribeAgent,
  reportTurnCompleted,
  waitOutSeveralTicks,
  withPipeline,
} from "../testing";

/** A fleet, a session and several ticks fit inside this. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 4 + 20_000 });

describe("the delivery of a queued input", () => {
  it("delivers to an idle session at once", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribeAgent(arranged, agent, REF);
      expect((await readSession(arranged, agent.session.id)).status).toBe("idle");

      await emitManualEvent(arranged, [REF], "delivered at once");

      const frame = await waitForFrameCarrying(arranged, "delivered at once");
      expect(frame.sessionId).toBe(agent.session.id);
      const rows = await waitForMatchedInputRows(
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
      const subscriptionId = await subscribeAgent(arranged, agent, REF);
      await makeBusy(arranged, agent, 2);

      await emitManualEvent(arranged, [REF], "the older one");
      await emitManualEvent(arranged, [REF], "the newer one");
      const waiting = await waitForMatchedInputRows(
        arranged.harness,
        subscriptionId,
        (found) => found.length >= 2,
      );
      expect(waiting.map((row) => row.status)).toEqual(["queued", "queued"]);
      // Neither row crosses the socket while the turn runs, however many ticks
      // the pipeline makes in the meantime.
      await waitOutSeveralTicks();
      expect(listFramesCarrying(arranged, "the older one")).toEqual([]);
      expect(listFramesCarrying(arranged, "the newer one")).toEqual([]);

      // The boundary releases them, oldest first.
      reportTurnCompleted(arranged, agent.session.id, 3);
      await waitForFrameCarrying(arranged, "the newer one");
      const sent = listInputFrames(arranged).map((frame) => frame.input.text);
      expect(sent.findIndex((text) => text.includes("the older one"))).toBeLessThan(
        sent.findIndex((text) => text.includes("the newer one")),
      );
      const rows = await waitForMatchedInputRows(arranged.harness, subscriptionId, (found) =>
        found.every((row) => row.status === "delivered"),
      );
      expect(rows.map((row) => row.text.includes("the older one"))).toEqual([true, false]);
    });
  });

  it("sends no second row while the first is on the wire and unanswered", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribeAgent(arranged, agent, REF);
      // The machine takes the frame and says nothing about it, so the turn it
      // opened has not started as far as the controller knows.
      arranged.wire.answering(() => undefined);

      await emitManualEvent(arranged, [REF], "the older one");
      await emitManualEvent(arranged, [REF], "the newer one");
      await waitForMatchedInputRows(arranged.harness, subscriptionId, (found) => found.length >= 2);

      // The oldest row goes out, and the newer one stays behind it however
      // many ticks pass: the runner takes one input per turn boundary, and a
      // second row sent now is a row it has to hold.
      await waitForFrameCarrying(arranged, "the older one");
      await waitOutSeveralTicks();
      expect(listFramesCarrying(arranged, "the newer one")).toEqual([]);

      // The machine answers at last, which is what lets the next row go.
      arranged.wire.release("opened");
      await waitForFrameCarrying(arranged, "the newer one");
    });
  });

  it("resumes a session whose harness is gone but whose transcript is not, and opens its turn with the row", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribeAgent(arranged, agent, REF);
      await exitSession(arranged, agent, 2);
      const ended = await readSession(arranged, agent.session.id);
      expect(ended.status).toBe("exited");
      expect(ended.resumable).toBe(true);

      await emitManualEvent(arranged, [REF], "wake up");

      // The session is told to start again, on its own native session.
      const starts = await waitForStartFrames(arranged, agent.session.id, 2);
      expect(starts[1]!.spec.continue).toMatchObject({ mode: "resume" });
      await waitForMatchedInputRows(arranged.harness, subscriptionId, (found) => found.length >= 1);

      // The resumed harness reports it is up, and the turn opens with the row.
      reportEvent(arranged.wire, 1, {
        eventId: crypto.randomUUID(),
        sessionId: agent.session.id,
        at,
        _tag: "session.started",
        providerRefs: { nativeSessionId: "native-1" },
      });
      const frame = await waitForFrameCarrying(arranged, "wake up");
      expect(frame.sessionId).toBe(agent.session.id);
    });
  });

  it("sends an input a person typed when the transition to idle was missed", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "typists");
      await makeBusy(arranged, agent, 2);

      const response = await post(
        arranged.harness.base,
        `/api/v1/sessions/${agent.session.id}/input`,
        { text: "typed while busy" },
        arranged.token,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      await waitOutSeveralTicks();
      expect(listFramesCarrying(arranged, "typed while busy")).toEqual([]);

      // The session goes idle without the turn boundary it is normally flushed
      // on. That is the transition a controller which stopped in the wrong
      // second never saw, and the row a person typed is left waiting for it.
      await runEffect(
        arranged.harness.sql`UPDATE sessions SET status = 'idle'
                             WHERE id = unhex(replace(${agent.session.id}, '-', ''))`,
      );

      // Nothing wrote the row again and nothing remembered it: the next tick
      // reads it and sends it, the same as it does for a matched input.
      const frame = await waitForFrameCarrying(arranged, "typed while busy");
      expect(frame.sessionId).toBe(agent.session.id);
    });
  });
});
