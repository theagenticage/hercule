/**
 * Integration tests for a session start that the runner answers while a
 * promotion freezes the controller, over the runner socket against a real
 * controller and one fake runner.
 *
 * The controller sends a start frame and waits for the runner to answer the
 * input the frame carries. The wait is not counted by the promotion gate, so
 * a freeze can begin while the controller is still waiting. The new
 * machine's copy of the data then holds the input as not yet answered. So an
 * answer that arrives during the freeze must not be recorded until the freeze
 * ends.
 */
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { freezeController, requestTransfer } from "../../promotion/testing";
import {
  WAIT_DEADLINE_MS,
  listInputs,
  spawnSessionOrFail,
  waitForStartFrames,
  waitUntil,
  withAgentFleet,
} from "../../sessions/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

describe("the answer to a session's start", () => {
  it("is recorded only after a promotion's freeze ends, when the runner answers during the freeze", async () => {
    await withAgentFleet(async (arranged) => {
      arranged.wire.answering(() => undefined);
      const session = await spawnSessionOrFail(arranged, { prompt: "hello" });
      await waitForStartFrames(arranged, session.id, 1);
      const promotionToken = await freezeController(arranged.harness.base, arranged.token);

      arranged.wire.release("opened");
      await delay(200);
      // Reading still works while frozen.
      expect((await listInputs(arranged, session.id)).map((input) => input.status)).not.toContain(
        "delivered",
      );

      const cancelled = await requestTransfer(arranged.harness.base, promotionToken, "DELETE");
      expect(cancelled.status).toBe(204);
      await waitUntil("recorded the answer to the start", async () => {
        const inputs = await listInputs(arranged, session.id);
        return inputs.some((input) => input.status === "delivered") ? inputs : undefined;
      });
    });
  });
});
