/**
 * Tests the guard on ending a step record: a record that has already ended
 * cannot be ended again. The run engine ends a record in the same transaction
 * as its action's effect, so the failure is what rolls that effect back when
 * something else, such as a cancellation, ended the record first.
 */
import { describe, expect, it } from "vitest";
import { Effect, Exit, Option } from "effect";
import { TestDatabase } from "../db/testing";
import { runRepository, StepRecordEnded } from "./repository";

const AT = "2026-09-24T10:00:00.000Z";
const TIMES = { startedAt: AT, finishedAt: AT };

describe("finishStep", () => {
  it("fails with StepRecordEnded when the record has already ended, and keeps the first ending", async () => {
    const [second, record] = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        const runId = yield* runs.insert(
          {
            workflowId: null,
            plan: { name: "File a task", steps: [] },
            inputs: {},
            origin: { kind: "manual", actor: "user" },
            entryStepIds: ["create"],
          },
          AT,
        );
        const step = { stepId: "create", iteration: 1 };
        yield* runs.cancelUnfinishedSteps(runId, AT);
        const second = yield* Effect.exit(
          runs.finishStep(runId, step, { status: "completed", output: {} }, TIMES),
        );
        const run = Option.getOrThrow(yield* runs.read(runId));
        return [second, run.steps[0]] as const;
      }).pipe(Effect.provide(TestDatabase)),
    );

    const error = Exit.isFailure(second)
      ? Option.getOrUndefined(Exit.findErrorOption(second))
      : undefined;
    expect(error).toBeInstanceOf(StepRecordEnded);
    expect(record?.status).toBe("cancelled");
    expect(record).not.toHaveProperty("output");
  });
});
