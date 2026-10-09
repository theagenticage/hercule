/**
 * Integration tests for runs while a promotion moves the controller's data,
 * driven over HTTP against a real controller.
 *
 * A run is held at `running` by a plugin action that waits until the test
 * releases it. The test spends a promotion token while the action waits,
 * which freezes the controller, and then releases the action. The step's
 * record must not end on the frozen controller: the new machine's copy was
 * taken before, and a write after it would be missing there.
 *
 * No runner is connected: action steps run on the controller.
 */
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { uuidFromString } from "../db";
import { SWITCH_PATH, TRANSFER_PATH } from "../promotion/exchange";
import { createPromotionToken } from "../promotion/testing";
import { WAIT_DEADLINE_MS } from "../sessions/testing";
import { withSetUpController } from "../workflows/testing";
import { buildHeldAction, readRun, startHeldRun, waitForRunToFinish } from "./testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS + 10_000 });

/** Spends `token` with a transfer, which freezes the controller until a switch or a cancel. */
const spendToken = async (base: string, token: string): Promise<void> => {
  const response = await fetch(`${base}${TRANSFER_PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, connection: "close" },
  });
  expect(response.status).toBe(200);
  await response.arrayBuffer();
};

describe("runs during a promotion", () => {
  it("holds a step's end while frozen, and ends it once the transfer is cancelled", async () => {
    const held = buildHeldAction();
    await withSetUpController(
      async ({ base, token }) => {
        const runId = await startHeldRun(base, token, held);
        const promotionToken = await createPromotionToken(base, token);
        await spendToken(base, promotionToken);

        held.release();
        await delay(200);
        const frozen = await readRun(base, token, runId);
        expect(frozen.status, JSON.stringify(frozen)).toBe("running");

        const cancelled = await fetch(`${base}${TRANSFER_PATH}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${promotionToken}`, connection: "close" },
        });
        expect(cancelled.status).toBe(204);
        const finished = await waitForRunToFinish(base, token, runId);
        expect(finished.status, JSON.stringify(finished)).toBe("completed");
      },
      [held.plugin],
    );
  });

  it("never ends the step on a sealed controller", async () => {
    const held = buildHeldAction();
    await withSetUpController(
      async ({ harness, base, token }) => {
        const runId = await startHeldRun(base, token, held);
        const promotionToken = await createPromotionToken(base, token);
        await spendToken(base, promotionToken);
        const switched = await fetch(`${base}${SWITCH_PATH}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${promotionToken}`,
            "content-type": "application/json",
            connection: "close",
          },
          body: JSON.stringify({ newAddress: "http://hercule.example:9" }),
        });
        expect(switched.status).toBe(200);

        held.release();
        await delay(200);
        // A sealed controller answers no request, so the run is read from its database.
        const rows = await Effect.runPromise(
          Effect.orDie(
            harness.sql<{ status: string }>`
              SELECT status FROM runs WHERE id = ${uuidFromString(runId)}
            `,
          ),
        );
        expect(rows.map((row) => row.status)).toEqual(["running"]);
      },
      [held.plugin],
    );
  });
});
