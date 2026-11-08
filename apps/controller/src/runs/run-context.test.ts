/**
 * Unit tests for the run context: what a step's templates and conditions can
 * read from the run's inputs and from the steps that have finished.
 */
import { describe, expect, it } from "vitest";
import type { StepRecord } from "@hercule/contract";
import { buildRunContext } from "./run-context";

const at = "2026-09-25T00:00:00.000Z";
const RUN_ID = "01a1b8a8-ac4e-778d-ae4d-282307b58fe1";
const TASK_ID = "01a1b8a8-ac4d-7787-871e-d1e6f2b97a74";

/** A completed record of `stepId` at `iteration`, with `output`. */
const buildCompleted = (stepId: string, iteration: number, output: unknown): StepRecord => ({
  stepId,
  iteration,
  status: "completed",
  startedAt: at,
  finishedAt: at,
  output: output as never,
});

describe("buildRunContext", () => {
  it("holds the output of each step's latest iteration, and leaves out a step whose latest iteration was skipped", () => {
    const context = buildRunContext({
      id: RUN_ID,
      inputs: { target: 3 },
      steps: [
        buildCompleted("count", 1, { n: 1 }),
        buildCompleted("count", 2, { n: 2 }),
        buildCompleted("review", 1, { ok: true }),
        { stepId: "review", iteration: 2, status: "skipped", finishedAt: at },
        { stepId: "count", iteration: 3, status: "pending" },
      ],
    });
    expect(context).toEqual({
      inputs: { target: 3 },
      run: { id: RUN_ID },
      steps: { count: { output: { n: 2 } } },
    });
  });

  it("names the Task in `run` when the run works on one, and leaves `taskId` out otherwise", () => {
    const withTask = buildRunContext({ id: RUN_ID, taskId: TASK_ID, inputs: {}, steps: [] });
    expect(withTask.run).toEqual({ id: RUN_ID, taskId: TASK_ID });
    const withoutTask = buildRunContext({ id: RUN_ID, inputs: {}, steps: [] });
    expect(withoutTask.run).toEqual({ id: RUN_ID });
  });
});
