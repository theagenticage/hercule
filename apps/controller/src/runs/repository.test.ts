/**
 * Tests the run repository against an in-memory database:
 *
 * - the guard on ending a step record: a record that has already ended
 *   cannot be ended again. The run engine ends a record in the same
 *   transaction as its action's effect, so the failure is what rolls that
 *   effect back when something else, such as a cancellation, ended the record
 *   first;
 * - the run a re-run names in `originalRunId`, as it is written, read back
 *   and filtered on.
 */
import { describe, expect, it } from "vitest";
import { Effect, Exit, Option } from "effect";
import { TestDatabase } from "../db/testing";
import { runRepository, StepRecordEnded, type NewRun } from "./repository";

const AT = "2026-09-24T10:00:00.000Z";
const TIMES = { startedAt: AT, finishedAt: AT };

/** A run with one entry step, and no run it re-runs. */
const NEW_RUN: NewRun = {
  workflowId: null,
  plan: { name: "File a task", steps: [] },
  inputs: {},
  origin: { kind: "manual", actor: "user" },
  entryStepIds: ["create"],
};

describe("finishStep", () => {
  it("fails with StepRecordEnded when the record has already ended, and keeps the first ending", async () => {
    const [second, record] = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        const runId = yield* runs.insert(NEW_RUN, AT);
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

describe("originalRunId", () => {
  it("reads back the run a re-run names, and leaves the field out for a run that re-runs nothing", async () => {
    const [original, rerun] = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        const originalId = yield* runs.insert(NEW_RUN, AT);
        const rerunId = yield* runs.insert({ ...NEW_RUN, originalRunId: originalId }, AT);
        return [
          Option.getOrThrow(yield* runs.read(originalId)),
          Option.getOrThrow(yield* runs.read(rerunId)),
        ] as const;
      }).pipe(Effect.provide(TestDatabase)),
    );

    expect(original).not.toHaveProperty("originalRunId");
    expect(rerun.originalRunId).toBe(original.id);
  });

  it("lists only the re-runs of the run the filter names, newest first", async () => {
    const [rerunIds, listed] = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        const originalId = yield* runs.insert(NEW_RUN, AT);
        const otherId = yield* runs.insert(NEW_RUN, AT);
        const first = yield* runs.insert(
          { ...NEW_RUN, originalRunId: originalId },
          "2026-09-24T10:01:00.000Z",
        );
        const second = yield* runs.insert(
          { ...NEW_RUN, originalRunId: originalId },
          "2026-09-24T10:02:00.000Z",
        );
        // A re-run of another run, and a re-run of a re-run, are not re-runs
        // of the original.
        yield* runs.insert({ ...NEW_RUN, originalRunId: otherId }, AT);
        yield* runs.insert({ ...NEW_RUN, originalRunId: first }, AT);
        const page = yield* runs.list({
          originalRunId: originalId,
          limit: 10,
          cursor: undefined,
          direction: "desc",
        });
        return [[second, first], page] as const;
      }).pipe(Effect.provide(TestDatabase)),
    );

    expect(listed.items.map((summary) => summary.id)).toEqual(rerunIds);
    expect(listed.nextCursor).toBeUndefined();
  });
});
