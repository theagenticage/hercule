/**
 * Unit tests for the run context: what a step's templates and conditions can
 * read from the run's inputs and from the steps that have finished.
 */
import { describe, expect, it } from "vitest";
import type { StepRecord } from "@hercule/contract";
import { buildRunContext } from "./run-context";

const at = "2026-09-25T00:00:00.000Z";

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
      inputs: { target: 3 },
      steps: [
        buildCompleted("count", 1, { n: 1 }),
        buildCompleted("count", 2, { n: 2 }),
        buildCompleted("review", 1, { ok: true }),
        { stepId: "review", iteration: 2, status: "skipped", finishedAt: at },
        { stepId: "count", iteration: 3, status: "pending" },
      ],
    });
    expect(context).toEqual({ inputs: { target: 3 }, steps: { count: { output: { n: 2 } } } });
  });
});
