/**
 * Integration tests for stopping runs, driven over HTTP against a real
 * controller: `POST /runs/{id}/cancel`, and `DELETE /workflows/{id}`, which is
 * refused while a run of the workflow is unfinished.
 *
 * A run is held at `running` by a plugin action that waits until the test
 * releases it or until its cancel signal aborts, so the test knows the run is
 * unfinished when it acts. A run at `pending` cannot be held by any request,
 * because the engine picks a new run up at once, so those tests write the
 * pending run's rows straight into the database.
 *
 * No runner is connected: action steps run on the controller.
 */
import { describe, expect, it, vi } from "vitest";
import type { Run } from "@hercule/contract";
import { del, get, readErrorBody } from "../http/testing";
import { WAIT_DEADLINE_MS, waitUntil } from "../sessions/testing";
import { ABSENT_ID, createWorkflowOrFail, withSetUpController } from "../workflows/testing";
import {
  buildCreateStep,
  buildHeldAction,
  buildHeldStep,
  findRecords,
  insertPendingRun,
  listTasks,
  readRun,
  requestCancel,
  startRun,
  waitForHeldExecutions,
  waitForRunToFinish,
  type HeldAction,
} from "./testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS + 10_000 });

/** The id of the pending run the tests insert. A UUIDv7, like every id the controller mints. */
const PENDING_RUN_ID = "0199f0b7-0000-7000-8000-00000000c001";

/**
 * Two entry steps that both wait, and a step after the first that would
 * create a task. Whether the engine runs the two entry steps one at a time or
 * together, at least one is running and the other is pending or running when
 * the test cancels.
 */
const buildHeldDefinition = (held: HeldAction) => ({
  name: "Wait, then file a task",
  steps: [buildHeldStep(held, "first"), buildHeldStep(held, "second"), buildCreateStep("after")],
  edges: [{ from: "first", to: "after" }],
});

/** Waits until the run's status is `running`, and returns the read. */
const waitForRunning = (base: string, token: string, id: string): Promise<Run> =>
  waitUntil(`started run ${id}`, async () => {
    const run = await readRun(base, token, id);
    return run.status === "running" ? run : undefined;
  });

/**
 * Reads the run a few times over a short while and checks that it stays
 * cancelled: every step record is still cancelled or was finished before the
 * cancel, and the step after the held ones never started. An action that
 * returns after the cancel must not move the run on.
 */
const expectStaysCancelled = async (base: string, token: string, id: string): Promise<void> => {
  for (let read = 0; read < 10; read += 1) {
    const run = await readRun(base, token, id);
    expect(run.status, JSON.stringify(run)).toBe("cancelled");
    expect(findRecords(run, "after"), JSON.stringify(run)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("POST /runs/{id}/cancel", () => {
  it("cancels a running run and its unfinished step records, aborts the action's signal, and starts no later step", async () => {
    const held = buildHeldAction();
    await withSetUpController(
      async ({ base, token }) => {
        try {
          const workflow = await createWorkflowOrFail(base, token, {
            definition: buildHeldDefinition(held),
          });
          const runId = await startRun(base, token, workflow.id);
          await waitForHeldExecutions(held, 1);
          const before = await waitForRunning(base, token, runId);
          const unfinished = before.steps
            .filter((record) => record.status === "pending" || record.status === "running")
            .map((record) => record.stepId);
          expect(unfinished.length, JSON.stringify(before)).toBeGreaterThanOrEqual(2);

          const response = await requestCancel(base, token, runId);
          expect(response.status, await response.clone().text()).toBe(200);
          const answered = (await response.json()) as Run;
          expect(answered.id).toBe(runId);
          expect(answered.status).toBe("cancelled");

          // Every execution that started sees its signal abort, which is how a
          // plugin action learns to stop the work it does outside the controller.
          await waitUntil("aborted the held action's signal", () =>
            held.contexts.every((context) => context.signal.aborted) ? true : undefined,
          );

          const run = await waitForRunToFinish(base, token, runId);
          expect(run.status, JSON.stringify(run)).toBe("cancelled");
          expect(run.finishedAt).toBeDefined();
          expect(run.failureReason).toBeUndefined();
          for (const stepId of unfinished) {
            expect(
              findRecords(run, stepId).map((record) => record.status),
              stepId,
            ).toEqual(["cancelled"]);
          }
          await expectStaysCancelled(base, token, runId);
          expect(await listTasks(base, token)).toEqual([]);
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });

  it("cancels a pending run and its pending step record", async () => {
    const held = buildHeldAction();
    await withSetUpController(
      async ({ harness, base, token }) => {
        try {
          const definition = { name: "Wait", steps: [buildHeldStep(held, "first")] };
          const workflow = await createWorkflowOrFail(base, token, { definition });
          await insertPendingRun(harness, {
            id: PENDING_RUN_ID,
            workflowId: workflow.id,
            plan: definition,
            stepId: "first",
          });

          const response = await requestCancel(base, token, PENDING_RUN_ID);
          expect(response.status, await response.clone().text()).toBe(200);

          const run = await waitForRunToFinish(base, token, PENDING_RUN_ID);
          expect(run.status, JSON.stringify(run)).toBe("cancelled");
          expect(run.finishedAt).toBeDefined();
          expect(run.steps.map((record) => [record.stepId, record.status])).toEqual([
            ["first", "cancelled"],
          ]);
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });

  it("refuses a completed, a failed and a cancelled run with invalid_state naming the run's status", async () => {
    const held = buildHeldAction();
    await withSetUpController(
      async ({ base, token }) => {
        try {
          const completed = await createWorkflowOrFail(base, token, {
            definition: { name: "One task", steps: [buildCreateStep("create")] },
          });
          const failed = await createWorkflowOrFail(base, token, {
            definition: {
              name: "Bad update",
              steps: [
                {
                  id: "update",
                  kind: "action",
                  action: "task.update",
                  params: { taskId: ABSENT_ID, status: "done" },
                },
              ],
            },
          });
          const waiting = await createWorkflowOrFail(base, token, {
            definition: { name: "Wait", steps: [buildHeldStep(held, "first")] },
          });

          const completedRun = await waitForRunToFinish(
            base,
            token,
            await startRun(base, token, completed.id),
          );
          expect(completedRun.status).toBe("completed");
          const failedRun = await waitForRunToFinish(
            base,
            token,
            await startRun(base, token, failed.id),
          );
          expect(failedRun.status).toBe("failed");
          const cancelledId = await startRun(base, token, waiting.id);
          await waitForHeldExecutions(held, 1);
          const cancelled = await requestCancel(base, token, cancelledId);
          expect(cancelled.status, await cancelled.clone().text()).toBe(200);
          const cancelledRun = await waitForRunToFinish(base, token, cancelledId);

          for (const finished of [completedRun, failedRun, cancelledRun]) {
            const response = await requestCancel(base, token, finished.id);
            const refusal = await readErrorBody(response);
            expect(response.status, refusal.text).toBe(409);
            expect(refusal.code).toBe("invalid_state");
            expect(refusal.message).toContain(finished.status);
            // The refusal changes nothing.
            expect(await readRun(base, token, finished.id)).toEqual(finished);
          }
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });
});

describe("DELETE /workflows/{id} with runs", () => {
  it("is refused with invalid_state while a run is running, then deletes once the run has finished, and the run keeps its workflow id and plan", async () => {
    const held = buildHeldAction();
    await withSetUpController(
      async ({ base, token }) => {
        try {
          const definition = { name: "Wait", steps: [buildHeldStep(held, "first")] };
          const workflow = await createWorkflowOrFail(base, token, { definition });
          const runId = await startRun(base, token, workflow.id);
          await waitForHeldExecutions(held, 1);
          await waitForRunning(base, token, runId);

          const refused = await del(base, `/api/v1/workflows/${workflow.id}`, token);
          expect(refused.status, await refused.clone().text()).toBe(409);
          expect((await readErrorBody(refused)).code).toBe("invalid_state");
          const stillThere = await get(base, `/api/v1/workflows/${workflow.id}`, token);
          expect(stillThere.status, "the refused delete left the workflow in place").toBe(200);

          held.release();
          const run = await waitForRunToFinish(base, token, runId);
          expect(run.status).toBe("completed");

          const deleted = await del(base, `/api/v1/workflows/${workflow.id}`, token);
          expect(deleted.status, await deleted.clone().text()).toBe(200);
          const kept = await readRun(base, token, runId);
          expect(kept.workflowId).toBe(workflow.id);
          expect(kept.plan).toEqual(definition);
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });

  it("is refused with invalid_state while a run is pending", async () => {
    const held = buildHeldAction();
    await withSetUpController(
      async ({ harness, base, token }) => {
        try {
          const definition = { name: "Wait", steps: [buildHeldStep(held, "first")] };
          const workflow = await createWorkflowOrFail(base, token, { definition });
          await insertPendingRun(harness, {
            id: PENDING_RUN_ID,
            workflowId: workflow.id,
            plan: definition,
            stepId: "first",
          });

          const refused = await del(base, `/api/v1/workflows/${workflow.id}`, token);
          expect(refused.status, await refused.clone().text()).toBe(409);
          expect((await readErrorBody(refused)).code).toBe("invalid_state");
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });
});
