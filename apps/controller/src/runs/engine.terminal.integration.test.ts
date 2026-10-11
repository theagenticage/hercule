/**
 * Integration tests for how a run ends, driven over HTTP against a real
 * controller:
 *
 * - a `terminal` step that completes ends the run at once, with the step's
 *   output as the run's `output`, and cancels every record still pending or
 *   running;
 * - a `terminal` step that is skipped does not end the run;
 * - a run with no terminal step completes once nothing is pending or
 *   running, and has no `output`.
 *
 * The steps that must still be running when the run ends are held by a
 * plugin action that waits until the test releases that step, or until its
 * cancel signal aborts.
 *
 * No runner is connected: action steps run on the controller.
 */
import { describe, expect, it, vi } from "vitest";
import type { Run } from "@hercule/contract";
import { WAIT_DEADLINE_MS, waitUntil } from "../sessions/testing";
import { createWorkflowOrFail, withSetUpController } from "../workflows/testing";
import {
  buildCreateStep,
  buildHeldAction,
  buildHeldStep,
  expectStatus,
  findStepRecords,
  listTasks,
  readRun,
  startRun,
  waitForHeldExecutions,
  waitForRun,
  waitForRunToFinish,
} from "./testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS + 10_000 });

/** Returns one step's records as `[iteration, status]`, in iteration order. */
const listIterations = (run: Run, stepId: string): ReadonlyArray<readonly [number, string]> =>
  [...findStepRecords(run, stepId)]
    .sort((left, right) => left.iteration - right.iteration)
    .map((record) => [record.iteration, record.status] as const);

describe("a terminal step that completes", () => {
  it("completes the run with its output, cancels every running and pending record, and follows none of its edges", async () => {
    const held = buildHeldAction();
    await withSetUpController(
      async ({ base, token }) => {
        try {
          // When `gate` is released, `finish` ends the run. At that moment:
          // - `pause` is waiting an hour;
          // - `other` is running its first iteration, and its second, added
          //   by `feeder`, is pending behind it.
          // `finish`'s own edges would create `after`, and would fail the run
          // on the condition that cannot be evaluated.
          const workflow = await createWorkflowOrFail(base, token, {
            definition: {
              name: "End early",
              steps: [
                buildHeldStep(held, "gate"),
                buildCreateStep("finish", { terminal: true }),
                buildCreateStep("after"),
                buildCreateStep("broken"),
                { id: "pause", kind: "action", action: "wait", params: { seconds: 3600 } },
                buildCreateStep("feeder"),
                { ...buildHeldStep(held, "other"), entry: true },
              ],
              edges: [
                { from: "gate", to: "finish" },
                { from: "finish", to: "after" },
                {
                  from: "finish",
                  to: "broken",
                  condition: "steps.finish.output.no_such_field == 1",
                },
                { from: "feeder", to: "other" },
              ],
            },
          });
          const runId = await startRun(base, token, workflow.id);
          await waitForHeldExecutions(held, 2);
          await waitForRun(
            base,
            token,
            runId,
            "queued a second record of other",
            (run) =>
              findStepRecords(run, "pause")[0]?.status === "running" &&
              JSON.stringify(listIterations(run, "other")) ===
                JSON.stringify([
                  [1, "running"],
                  [2, "pending"],
                ]),
          );

          held.releaseStep("gate");
          const run = await waitForRunToFinish(base, token, runId);

          const completed = expectStatus(run, "completed");
          const finish = expectStatus(findStepRecords(run, "finish")[0], "completed");
          expect(completed.output, JSON.stringify(run)).toEqual(finish.output);
          expect(listIterations(run, "gate")).toEqual([[1, "completed"]]);
          expect(listIterations(run, "feeder")).toEqual([[1, "completed"]]);
          expect(listIterations(run, "pause")).toEqual([[1, "cancelled"]]);
          expect(listIterations(run, "other")).toEqual([
            [1, "cancelled"],
            [2, "cancelled"],
          ]);
          expect(findStepRecords(run, "after")).toEqual([]);
          expect(findStepRecords(run, "broken")).toEqual([]);
          expect(run.edgeTraversals).toEqual([1, 0, 0, 1]);
          expect((await listTasks(base, token)).map((task) => task.title).sort()).toEqual([
            "File the feeder task",
            "File the finish task",
          ]);

          // The running plugin action learns that its run ended.
          const other = held.contexts.find((context) => context.run?.stepId === "other");
          await waitUntil("aborted the signal of the other step", () =>
            other?.signal.aborted === true ? true : undefined,
          );
          // The action returns once its signal aborts, and that must not
          // move the completed run on.
          expect(await readRun(base, token, runId)).toEqual(run);
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });
});

describe("a terminal step that is skipped", () => {
  it("does not end the run, and its edges pass through", async () => {
    await withSetUpController(async ({ base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: {
          name: "Skip the end",
          steps: [
            buildCreateStep("root"),
            buildCreateStep("maybe", { terminal: true, condition: "false" }),
            buildCreateStep("after"),
          ],
          edges: [
            { from: "root", to: "maybe" },
            { from: "maybe", to: "after" },
          ],
        },
      });

      const run = await waitForRunToFinish(base, token, await startRun(base, token, workflow.id));

      expect(run.status, JSON.stringify(run)).toBe("completed");
      expect(listIterations(run, "maybe")).toEqual([[1, "skipped"]]);
      expect(listIterations(run, "after")).toEqual([[1, "completed"]]);
      expect("output" in run, JSON.stringify(run)).toBe(false);
    });
  });
});

describe("a run with no terminal step", () => {
  it("completes only when nothing is running or pending, and has no output", async () => {
    const held = buildHeldAction();
    await withSetUpController(
      async ({ base, token }) => {
        try {
          // `long` is held, and `tail` runs after it. `short` ends at once,
          // though its record is created after `long`'s.
          const workflow = await createWorkflowOrFail(base, token, {
            definition: {
              name: "One short branch, one long",
              steps: [
                buildHeldStep(held, "long"),
                buildCreateStep("tail"),
                buildCreateStep("short"),
              ],
              edges: [{ from: "long", to: "tail" }],
            },
          });
          const runId = await startRun(base, token, workflow.id);
          await waitForHeldExecutions(held, 1);
          const shortEnded = await waitForRun(
            base,
            token,
            runId,
            "completed the short step",
            (run) => findStepRecords(run, "short")[0]?.status === "completed",
          );
          expect(shortEnded.status, JSON.stringify(shortEnded)).toBe("running");
          expect(listIterations(shortEnded, "long")).toEqual([[1, "running"]]);

          held.releaseStep("long");
          const run = await waitForRunToFinish(base, token, runId);

          expect(run.status, JSON.stringify(run)).toBe("completed");
          expect(listIterations(run, "tail")).toEqual([[1, "completed"]]);
          expect("output" in run, JSON.stringify(run)).toBe(false);
        } finally {
          held.release();
        }
      },
      [held.plugin],
    );
  });
});
