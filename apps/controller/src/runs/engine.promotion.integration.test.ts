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
import { freezeController, requestTransfer, sealController } from "../promotion/testing";
import { WAIT_DEADLINE_MS } from "../sessions/testing";
import { withSetUpController } from "../workflows/testing";
import { buildHeldAction, readRun, startHeldRun, waitForRunToFinish } from "./testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS + 10_000 });

describe("runs during a promotion", () => {
  it("holds a step's end while frozen, and ends it once the transfer is cancelled", async () => {
    const held = buildHeldAction();
    await withSetUpController(
      async ({ base, token }) => {
        const runId = await startHeldRun(base, token, held);
        const promotionToken = await freezeController(base, token);

        held.release();
        await delay(200);
        const frozen = await readRun(base, token, runId);
        expect(frozen.status, JSON.stringify(frozen)).toBe("running");

        const cancelled = await requestTransfer(base, promotionToken, "DELETE");
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
        const promotionToken = await freezeController(base, token);
        await sealController(base, promotionToken);

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
