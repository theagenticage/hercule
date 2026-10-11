/**
 * Integration tests for a run executing its ready steps side by side, driven
 * over HTTP against a real controller:
 *
 * - steps on parallel branches are `running` at the same time;
 * - an edge that fires into a step whose record is running queues a pending
 *   record, which starts only after the running one ends, in iteration order;
 * - a step that fails ends the run, and its parallel branches are cancelled;
 * - a controller error at one step ends the run the same way, and so does a
 *   plugin action that ends in its own interrupt;
 * - cancelling the run cancels every branch and stops its work;
 * - a controller that stops while branches are running stops their work, and
 *   continues the run by the restart rules when it boots again.
 *
 * The steps are held by a plugin action that waits until the test releases
 * that step, or until its cancel signal aborts. So the test decides the
 * order in which steps end, and never waits a fixed time for one to happen.
 *
 * No runner is connected: action steps run on the controller.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect, Schema } from "effect";
import type { Run } from "@hercule/contract";
import { buildActionPlugin } from "../plugins/testing";
import { WAIT_DEADLINE_MS, waitUntil } from "../sessions/testing";
import { ABSENT_ID, createWorkflowOrFail, withSetUpController } from "../workflows/testing";
import {
  buildCreateStep,
  buildHeldAction,
  buildHeldStep,
  expectStatus,
  findStepRecords,
  readRun,
  requestCancel,
  startRun,
  waitForHeldExecutions,
  waitForRun,
  waitForRunToFinish,
} from "./testing";
import { runEffect } from "../daemon/testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS + 10_000 });

/** Returns one step's records as `[iteration, status]`, in iteration order. */
const listIterations = (run: Run, stepId: string): ReadonlyArray<readonly [number, string]> =>
  [...findStepRecords(run, stepId)]
    .sort((left, right) => left.iteration - right.iteration)
    .map((record) => [record.iteration, record.status] as const);

/** Fails the test if any step of the run has more than one `running` record. */
const expectOneRunningRecordPerStep = (run: Run): void => {
  const running = run.steps
    .filter((record) => record.status === "running")
    .map((record) => record.stepId);
  expect(running, `two running records of one step: ${JSON.stringify(run)}`).toEqual([
    ...new Set(running),
  ]);
};

describe("steps on parallel branches", () => {
  it("are running at the same time, and each ends when its own action returns", async () => {
    const held = buildHeldAction();
    await withSetUpController(
      async ({ base, token }) => {
        try {
          const workflow = await createWorkflowOrFail(base, token, {
            definition: {
              name: "Two branches",
              steps: [
                buildCreateStep("root"),
                buildHeldStep(held, "left"),
                buildHeldStep(held, "right"),
              ],
              edges: [
                { from: "root", to: "left" },
                { from: "root", to: "right" },
              ],
            },
          });
          const runId = await startRun(base, token, workflow.id);

          await waitForHeldExecutions(held, 2);
          const both = await readRun(base, token, runId);
          expect(listIterations(both, "left"), JSON.stringify(both)).toEqual([[1, "running"]]);
          expect(listIterations(both, "right"), JSON.stringify(both)).toEqual([[1, "running"]]);

          held.releaseStep("left");
          const leftEnded = await waitForRun(base, token, runId, "completed the left step", (run) =>
            listIterations(run, "left").some(([, status]) => status === "completed"),
          );
          expect(leftEnded.status).toBe("running");
          expect(listIterations(leftEnded, "right")).toEqual([[1, "running"]]);

          held.releaseStep("right");
          const run = await waitForRunToFinish(base, token, runId);
          expect(run.status, JSON.stringify(run)).toBe("completed");
          // The two records overlapped: `right` started before `left` finished.
          const left = expectStatus(findStepRecords(run, "left")[0], "completed");
          const right = expectStatus(findStepRecords(run, "right")[0], "completed");
          expect(right.startedAt <= left.finishedAt, JSON.stringify(run)).toBe(true);
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });
});

describe("an edge that fires into a step whose record is running", () => {
  it("adds a pending record with the next iteration, which starts after the running one ends, in iteration order", async () => {
    const held = buildHeldAction();
    await withSetUpController(
      async ({ base, token }) => {
        try {
          // Three entry steps lead into `busy`, so `busy` gets one record per
          // entry step, in the order the test releases them.
          const workflow = await createWorkflowOrFail(base, token, {
            definition: {
              name: "A busy step",
              steps: [
                buildHeldStep(held, "first"),
                buildHeldStep(held, "second"),
                buildHeldStep(held, "third"),
                buildHeldStep(held, "busy"),
              ],
              edges: [
                { from: "first", to: "busy" },
                { from: "second", to: "busy" },
                { from: "third", to: "busy" },
              ],
            },
          });
          const runId = await startRun(base, token, workflow.id);
          /** Waits until `busy`'s records are `expected`, checking every read on the way. */
          const waitForBusy = (expected: ReadonlyArray<readonly [number, string]>) =>
            waitForRun(base, token, runId, `reached busy ${JSON.stringify(expected)}`, (run) => {
              expectOneRunningRecordPerStep(run);
              return JSON.stringify(listIterations(run, "busy")) === JSON.stringify(expected);
            });

          await waitForHeldExecutions(held, 3);
          held.releaseStep("first");
          await waitForBusy([[1, "running"]]);

          held.releaseStep("second");
          held.releaseStep("third");
          await waitForBusy([
            [1, "running"],
            [2, "pending"],
            [3, "pending"],
          ]);

          await waitForHeldExecutions(held, 4);
          held.releaseStep("busy");
          await waitForBusy([
            [1, "completed"],
            [2, "running"],
            [3, "pending"],
          ]);

          await waitForHeldExecutions(held, 5);
          held.releaseStep("busy");
          await waitForBusy([
            [1, "completed"],
            [2, "completed"],
            [3, "running"],
          ]);

          await waitForHeldExecutions(held, 6);
          held.releaseStep("busy");
          const run = await waitForRunToFinish(base, token, runId);
          expect(run.status, JSON.stringify(run)).toBe("completed");
          const busy = [...findStepRecords(run, "busy")].sort(
            (left, right) => left.iteration - right.iteration,
          );
          for (const [index, record] of busy.slice(1).entries()) {
            const before = expectStatus(busy[index], "completed");
            expect(
              expectStatus(record, "completed").startedAt >= before.finishedAt,
              `busy#${String(record.iteration)} started before busy#${String(before.iteration)} finished`,
            ).toBe(true);
          }
          expect(held.contexts.filter((context) => context.run?.stepId === "busy")).toHaveLength(3);
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });
});

describe("a step that fails while other branches are running", () => {
  it("fails the run with step-failed, and cancels the running branches, which see their abort", async () => {
    const held = buildHeldAction();
    await withSetUpController(
      async ({ base, token }) => {
        try {
          // `gate` leads to `broken`, which updates a task that does not
          // exist. `slow` and `pause` are still running when it fails.
          const workflow = await createWorkflowOrFail(base, token, {
            definition: {
              name: "A failing branch",
              steps: [
                buildHeldStep(held, "slow"),
                { id: "pause", kind: "action", action: "wait", params: { seconds: 3600 } },
                buildHeldStep(held, "gate"),
                {
                  id: "broken",
                  kind: "action",
                  action: "task.update",
                  params: { taskId: ABSENT_ID, status: "in-progress" },
                },
              ],
              edges: [{ from: "gate", to: "broken" }],
            },
          });
          const runId = await startRun(base, token, workflow.id);
          await waitForHeldExecutions(held, 2);
          await waitForRun(base, token, runId, "started every entry step", (run) =>
            ["slow", "pause", "gate"].every(
              (stepId) => findStepRecords(run, stepId)[0]?.status === "running",
            ),
          );

          held.releaseStep("gate");
          const run = await waitForRunToFinish(base, token, runId);

          const failed = expectStatus(run, "failed");
          expect(failed.failureReason).toBe("step-failed");
          expect(failed).toMatchObject({ failedStepId: "broken" });
          expect(expectStatus(findStepRecords(run, "broken")[0], "failed").error.code).toBe(
            "not_found",
          );
          expect(listIterations(run, "gate")).toEqual([[1, "completed"]]);
          expect(listIterations(run, "slow")).toEqual([[1, "cancelled"]]);
          expect(listIterations(run, "pause")).toEqual([[1, "cancelled"]]);
          const slow = held.contexts.find((context) => context.run?.stepId === "slow");
          await waitUntil("aborted the signal of the slow step", () =>
            slow?.signal.aborted === true ? true : undefined,
          );
          // The slow step's action returns once its signal aborts, and that
          // must not move the failed run on.
          expect(await readRun(base, token, runId)).toEqual(run);
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });
});

describe("a controller error at a step while other branches are running", () => {
  it("fails the run with controller-error at that step, and cancels the running branches, which see their abort", async () => {
    const held = buildHeldAction();
    await withSetUpController(
      async ({ harness, base, token }) => {
        try {
          // `gate` leads to `create`, whose task the database refuses to
          // write. `slow` is still running when that happens.
          const workflow = await createWorkflowOrFail(base, token, {
            definition: {
              name: "A broken database on one branch",
              steps: [
                buildHeldStep(held, "slow"),
                buildHeldStep(held, "gate"),
                buildCreateStep("create"),
              ],
              edges: [{ from: "gate", to: "create" }],
            },
          });
          // Stands in for a database that cannot write, such as a full disk.
          await runEffect(
            harness.sql`
              CREATE TRIGGER refuse_task_insert BEFORE INSERT ON tasks
              BEGIN SELECT RAISE(ABORT, 'the disk is full'); END`,
          );
          const runId = await startRun(base, token, workflow.id);
          await waitForHeldExecutions(held, 2);

          held.releaseStep("gate");
          const run = await waitForRunToFinish(base, token, runId);

          const failed = expectStatus(run, "failed");
          expect(failed.failureReason).toBe("controller-error");
          expect(failed).toMatchObject({ failedStepId: "create" });
          expect(expectStatus(findStepRecords(run, "create")[0], "failed").error.code).toBe(
            "unexpected",
          );
          expect(listIterations(run, "slow")).toEqual([[1, "cancelled"]]);
          const slow = held.contexts.find((context) => context.run?.stepId === "slow");
          await waitUntil("aborted the signal of the slow step", () =>
            slow?.signal.aborted === true ? true : undefined,
          );
          expect(await readRun(base, token, runId)).toEqual(run);
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });
});

describe("a plugin action that ends in its own interrupt while other branches are running", () => {
  it("fails the run with controller-error at that step, and cancels the running branches", async () => {
    const held = buildHeldAction();
    // An action whose effect ends interrupted, as one that joins an
    // interrupted fiber does. Nothing outside the step interrupted it.
    const interrupting = buildActionPlugin("halting", {
      id: "halt",
      displayName: "Halt",
      description: "Ends in its own interrupt.",
      input: Schema.Struct({}),
      output: Schema.Struct({}),
      execute: () => Effect.interrupt,
    });
    await withSetUpController(
      async ({ base, token }) => {
        try {
          const workflow = await createWorkflowOrFail(base, token, {
            definition: {
              name: "An action that interrupts itself",
              steps: [
                buildHeldStep(held, "slow"),
                buildHeldStep(held, "gate"),
                { id: "halt", kind: "action", action: "halting/halt", params: {} },
              ],
              edges: [{ from: "gate", to: "halt" }],
            },
          });
          const runId = await startRun(base, token, workflow.id);
          await waitForHeldExecutions(held, 2);

          held.releaseStep("gate");
          const run = await waitForRunToFinish(base, token, runId);

          const failed = expectStatus(run, "failed");
          expect(failed.failureReason).toBe("controller-error");
          expect(failed).toMatchObject({ failedStepId: "halt" });
          expect(expectStatus(findStepRecords(run, "halt")[0], "failed").error.code).toBe(
            "unexpected",
          );
          expect(listIterations(run, "slow")).toEqual([[1, "cancelled"]]);
          const slow = held.contexts.find((context) => context.run?.stepId === "slow");
          await waitUntil("aborted the signal of the slow step", () =>
            slow?.signal.aborted === true ? true : undefined,
          );
          expect(await readRun(base, token, runId)).toEqual(run);
        } finally {
          held.release();
        }
      },
      [held.plugin, interrupting],
    );
  });
});

/** Builds a definition with a held step `slow` and a `wait` step `pause` on separate branches. */
const buildHeldAndWaitingDefinition = (held: ReturnType<typeof buildHeldAction>) => ({
  name: "A held branch and a waiting branch",
  steps: [
    buildHeldStep(held, "slow"),
    { id: "pause", kind: "action", action: "wait", params: { seconds: 3600 } },
    buildCreateStep("after"),
  ],
  edges: [{ from: "pause", to: "after" }],
});

/** Starts a run of the definition from `buildHeldAndWaitingDefinition` and waits until both branches are running. */
const startHeldAndWaitingRun = async (
  base: string,
  token: string,
  held: ReturnType<typeof buildHeldAction>,
): Promise<string> => {
  const workflow = await createWorkflowOrFail(base, token, {
    definition: buildHeldAndWaitingDefinition(held),
  });
  const runId = await startRun(base, token, workflow.id);
  await waitForHeldExecutions(held, 1);
  await waitForRun(base, token, runId, "started both branches", (run) =>
    ["slow", "pause"].every((stepId) => findStepRecords(run, stepId)[0]?.status === "running"),
  );
  return runId;
};

describe("cancelling a run while a plugin action and a wait run on separate branches", () => {
  it("cancels both, the plugin action sees its abort, and nothing runs after the wait", async () => {
    const held = buildHeldAction();
    await withSetUpController(
      async ({ base, token }) => {
        try {
          const runId = await startHeldAndWaitingRun(base, token, held);

          const response = await requestCancel(base, token, runId);
          expect(response.status, await response.clone().text()).toBe(200);
          const run = await waitForRunToFinish(base, token, runId);

          expect(run.status, JSON.stringify(run)).toBe("cancelled");
          expect(listIterations(run, "slow")).toEqual([[1, "cancelled"]]);
          expect(listIterations(run, "pause")).toEqual([[1, "cancelled"]]);
          expect(findStepRecords(run, "after")).toEqual([]);
          const slow = held.contexts[0];
          await waitUntil("aborted the signal of the slow step", () =>
            slow?.signal.aborted === true ? true : undefined,
          );
          expect(await readRun(base, token, runId)).toEqual(run);
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });
});

describe("a controller that stops while a plugin action and a wait run on separate branches", () => {
  it("stops both, the plugin action sees its abort, and on boot the run fails with interrupted at the plugin step", async () => {
    const held = buildHeldAction();
    await withSetUpController(
      async ({ harness, base, token }) => {
        try {
          const runId = await startHeldAndWaitingRun(base, token, held);

          await harness.reboot();
          // The stop interrupted the step's fiber, which aborted its signal
          // before the boot resumed the run.
          expect(held.contexts[0]?.signal.aborted).toBe(true);
          const run = await waitForRunToFinish(base, token, runId);

          // A plugin action cut off by a stop may or may not have taken
          // effect, so it is never executed again: the run fails at it, and
          // the wait, which would have been resumed, is cancelled with it.
          const failed = expectStatus(run, "failed");
          expect(failed.failureReason).toBe("step-failed");
          expect(failed).toMatchObject({ failedStepId: "slow" });
          expect(expectStatus(findStepRecords(run, "slow")[0], "failed").error.code).toBe(
            "interrupted",
          );
          expect(listIterations(run, "pause")).toEqual([[1, "cancelled"]]);
          expect(findStepRecords(run, "after")).toEqual([]);
          expect(held.contexts).toHaveLength(1);
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });
});
