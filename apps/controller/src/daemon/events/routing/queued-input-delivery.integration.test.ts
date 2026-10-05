/**
 * Tests the delivery of queued inputs to an idle, a busy, an exited and a
 * stalled session.
 *
 * Every test goes through the whole pipeline, because a delivery only counts
 * when a frame crosses the runner socket. The rows are written in both ways
 * rows are written, by a match and by a person typing, because the delivery
 * treats them the same.
 */
import { describe, expect, it, vi } from "vitest";
import {
  readSession,
  listInputs,
  waitForSession,
  waitForStartFrames,
  WAIT_DEADLINE_MS,
} from "../../../sessions/testing";
import { post } from "../../../http/testing";
import {
  emitManualEvent,
  endPromptTurn,
  exitSession,
  waitForFrameCarrying,
  makeBusy,
  REF,
  waitForMatchedInputRows,
  runEffect,
  listFramesCarrying,
  spawnSubscriber,
  subscribeThread,
  reportTurnCompleted,
  waitOutSeveralTicks,
  withPipeline,
  listInputFrames,
} from "../../testing";

/** Long enough for a fleet, a session and several ticks. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 4 + 20_000 });

describe("the delivery of a queued input", () => {
  it("delivers to an idle session at once", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribeThread(arranged, agent, REF);
      await endPromptTurn(arranged, agent);

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

  it("keeps a busy session's inputs waiting, and sends the oldest first when the turn ends", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribeThread(arranged, agent, REF);
      await makeBusy(arranged, agent, 2);

      await emitManualEvent(arranged, [REF], "the older one");
      await emitManualEvent(arranged, [REF], "the newer one");
      const waiting = await waitForMatchedInputRows(
        arranged.harness,
        subscriptionId,
        (found) => found.length >= 2,
      );
      expect(waiting.map((row) => row.status)).toEqual(["queued", "queued"]);
      // Neither row is sent while the turn runs, however many ticks pass.
      await waitOutSeveralTicks();
      expect(listFramesCarrying(arranged, "the older one")).toEqual([]);
      expect(listFramesCarrying(arranged, "the newer one")).toEqual([]);

      // The end of the turn releases the oldest one. The runner answers that
      // it opened a turn, so the newer one waits for that turn to end.
      reportTurnCompleted(arranged, agent.session.id, 3);
      await waitForFrameCarrying(arranged, "the older one");
      await waitOutSeveralTicks();
      expect(listFramesCarrying(arranged, "the newer one")).toEqual([]);
      reportTurnCompleted(arranged, agent.session.id, 4);
      await waitForFrameCarrying(arranged, "the newer one");
      const rows = await waitForMatchedInputRows(arranged.harness, subscriptionId, (found) =>
        found.every((row) => row.status === "delivered"),
      );
      expect(rows.map((row) => row.text.includes("the older one"))).toEqual([true, false]);
    });
  });

  it("sends no second input while the first is sent and unanswered", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribeThread(arranged, agent, REF);
      await endPromptTurn(arranged, agent);
      // The fake runner accepts the frame and reports nothing, so as far as the
      // controller knows, the turn has not started.
      arranged.wire.answering(() => undefined);

      await emitManualEvent(arranged, [REF], "the older one");
      await emitManualEvent(arranged, [REF], "the newer one");
      await waitForMatchedInputRows(arranged.harness, subscriptionId, (found) => found.length >= 2);

      // The oldest row is sent, and the newer one waits however many ticks
      // pass: the runner takes one input per turn, and a second row sent now
      // would have to be held by the runner.
      await waitForFrameCarrying(arranged, "the older one");
      await waitOutSeveralTicks();
      expect(listFramesCarrying(arranged, "the newer one")).toEqual([]);

      // The runner finally answers that the input opened a turn, and the end
      // of that turn lets the next row be sent.
      arranged.wire.release("opened");
      await waitForSession(arranged, agent.session.id, (one) => one.status === "busy");
      reportTurnCompleted(arranged, agent.session.id, 3);
      await waitForFrameCarrying(arranged, "the newer one");
    });
  });

  it("resumes an exited session whose transcript still exists, and starts its turn with the input", async () => {
    await withPipeline(async (arranged) => {
      const agent = await spawnSubscriber(arranged, "subscribers");
      const subscriptionId = await subscribeThread(arranged, agent, REF);
      await exitSession(arranged, agent, 2);
      const ended = await readSession(arranged, agent.session.id);
      expect(ended.status).toBe("exited");
      expect(ended.resumable).toBe(true);

      await emitManualEvent(arranged, [REF], "wake up");

      // The runner is told to start the session again, on its own native
      // session, and the start carries the row, which opens the first turn.
      const starts = await waitForStartFrames(arranged, agent.session.id, 2);
      expect(starts[1]!.spec.continue).toMatchObject({ mode: "resume" });
      await waitForMatchedInputRows(arranged.harness, subscriptionId, (found) => found.length >= 1);
      const row = (await listInputs(arranged, agent.session.id)).find((one) =>
        one.text.includes("wake up"),
      );
      expect(starts[1]!.requestId).toBe(row!.id);
      expect(starts[1]!.input.text).toBe(row!.text);
      await waitForSession(arranged, agent.session.id, (one) => one.status === "busy");
      expect(listInputFrames(arranged).filter((frame) => frame.requestId === row!.id)).toEqual([]);
    });
  });

  it("sends an input a person typed when the change to idle was missed", async () => {
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

      // The session goes idle without the turn end that normally flushes it,
      // as when the controller stopped at the wrong moment and missed the
      // change. The row a person typed is left waiting.
      await runEffect(
        arranged.harness.sql`UPDATE sessions SET status = 'idle'
                             WHERE id = unhex(replace(${agent.session.id}, '-', ''))`,
      );

      // Nothing rewrote the row or remembered it: the next tick reads it and
      // sends it, the same as for a matched input.
      const frame = await waitForFrameCarrying(arranged, "typed while busy");
      expect(frame.sessionId).toBe(agent.session.id);
    });
  });
});
