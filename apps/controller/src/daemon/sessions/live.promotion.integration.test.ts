/**
 * Integration tests for a message steered into a conversation session's
 * running turn while a promotion freezes the controller, over HTTP and the
 * runner socket against a real controller and one fake runner.
 *
 * `conversation.send` stores the message, and the steer runs after the
 * request has ended: it sends the input to the runner, waits for the answer,
 * and records it. The steer is counted by the promotion gate, so a freeze
 * waits for the answer to be recorded before the data is copied. Otherwise
 * the answer would be written after the copy, where the new machine never
 * sees it.
 */
import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { SessionInput } from "@hercule/protocol";
import { createPromotionToken, requestTransfer, QUIET_LOOP_TIMINGS } from "../../promotion/testing";
import {
  WAIT_DEADLINE_MS,
  at,
  listFrames,
  listInputs,
  reportEvent,
  waitForSession,
  waitUntil,
  withAgentFleet,
} from "../../sessions/testing";
import {
  readDefaultConversation,
  sendMessage,
  startConversationSession,
} from "../../conversations/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

describe("a message steered into a conversation session's turn", () => {
  it("is answered and recorded before a promotion's freeze copies the data", async () => {
    await withAgentFleet(async (arranged) => {
      const { conversation } = await readDefaultConversation(arranged);
      const session = await startConversationSession(arranged, conversation.id, "hi");
      reportEvent(arranged.wire, 2, {
        eventId: crypto.randomUUID(),
        sessionId: session.id,
        at,
        _tag: "turn.started",
        turnId: "t1",
      });
      await waitForSession(arranged, session.id, (one) => one.status === "busy");
      arranged.wire.answering(() => undefined);
      await sendMessage(arranged, conversation.id, "also this");
      await waitUntil("sent the steered message", () =>
        listFrames<SessionInput>(arranged.wire, "sessionInput").find(
          (one) => one.input.text === "also this",
        ),
      );

      const promotionToken = await createPromotionToken(arranged.harness.base, arranged.token);
      let copied = false;
      const transfer = requestTransfer(arranged.harness.base, promotionToken).then((response) => {
        copied = true;
        return response;
      });
      // The freeze copies the data only once no counted work is running. The
      // steer is the one unit of work running when the freeze starts, and it
      // runs until the runner answers, so the copy waits for that answer.
      const frozen = await Effect.runPromise(
        arranged.harness.promotion.gateChanges.pipe(
          Stream.filter((state) => state.phase._tag === "Frozen"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        ),
      );
      expect(frozen.running).toBe(1);
      expect(copied).toBe(false);

      arranged.wire.release("steered");
      const response = await transfer;
      expect(response.status).toBe(200);
      // Read to the end: a transfer stream that breaks off ends the freeze.
      await response.arrayBuffer();
      const steered = (await listInputs(arranged, session.id)).find(
        (one) => one.text === "also this",
      );
      expect(steered).toMatchObject({ status: "delivered", delivery: "steered" });
      const cancelled = await requestTransfer(arranged.harness.base, promotionToken, "DELETE");
      expect(cancelled.status).toBe(204);
    }, QUIET_LOOP_TIMINGS);
  });
});
