/**
 * Tests the run repository against an in-memory database:
 *
 * - the guard on ending a step record: a record that has already ended
 *   cannot be ended again. The run engine ends a record in the same
 *   transaction as its action's effect, so the failure is what rolls that
 *   effect back when something else, such as a cancellation, ended the record
 *   first;
 * - the run a re-run names in `originalRunId`, as it is written, read back
 *   and filtered on;
 * - where a running run's summary says the run is: its active steps and the
 *   signals it waits on;
 * - the `activeSince` filter, which keeps the runs that had not ended before
 *   an instant.
 */
import { describe, expect, it } from "vitest";
import { Effect, Exit, Option } from "effect";
import { TestDatabase } from "../db/testing";
import type { RunFilter, RunSummary, WorkflowDefinition } from "@hercule/contract";
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

/** A workflow at its `review` step, which then waits on two signals. */
const SIGNALLED_PLAN = {
  name: "Ship release",
  steps: [],
  triggers: [
    {
      id: "approved",
      kind: "signal",
      on: { kind: "github.pr.review_approved" },
      correlation: { event: "event.payload.pr", run: "inputs.pr" },
    },
    {
      id: "merged",
      kind: "signal",
      on: { kind: "github.pr.merged" },
      correlation: { event: "event.payload.pr", run: "inputs.pr" },
    },
  ],
} as unknown as WorkflowDefinition;

/** Returns every run the filter keeps, newest first, as one page. */
const listRuns = (filter: RunFilter) =>
  Effect.gen(function* () {
    const runs = yield* runRepository;
    const page = yield* runs.list({ ...filter, limit: 100, cursor: undefined, direction: "desc" });
    return page.items;
  });

/** Returns where the one listed run is: its status and the two fields of a running summary. */
const locate = (summary: RunSummary | undefined) => ({
  status: summary?.status,
  activeStepIds:
    summary !== undefined && "activeStepIds" in summary ? summary.activeStepIds : undefined,
  awaitedSignalIds:
    summary !== undefined && "awaitedSignalIds" in summary ? summary.awaitedSignalIds : undefined,
});

describe("where a running run's summary says the run is", () => {
  it("lists the running step, and not the pending ones, while a step runs", async () => {
    const [summary] = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        const runId = yield* runs.insert({ ...NEW_RUN, entryStepIds: ["review"] }, AT);
        yield* runs.start(runId, AT);
        yield* runs.startStep(
          runId,
          { stepId: "review", iteration: 1 },
          { input: {}, checkoutBranch: undefined },
          AT,
        );
        yield* runs.insertSteps(runId, ["notify"], AT);
        return yield* listRuns({});
      }).pipe(Effect.provide(TestDatabase)),
    );

    expect(locate(summary)).toEqual({
      status: "running",
      activeStepIds: ["review"],
      awaitedSignalIds: [],
    });
  });

  it("lists each pending step once, in the order its records were created, when none runs", async () => {
    const [summary] = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        const runId = yield* runs.insert({ ...NEW_RUN, entryStepIds: ["build", "lint"] }, AT);
        yield* runs.start(runId, AT);
        // A second pending record of `build`, queued behind its first.
        yield* runs.insertSteps(runId, ["build"], AT);
        return yield* listRuns({});
      }).pipe(Effect.provide(TestDatabase)),
    );

    expect(locate(summary)).toEqual({
      status: "running",
      activeStepIds: ["build", "lint"],
      awaitedSignalIds: [],
    });
  });

  it("lists the plan's signal triggers, in the plan's order, once nothing runs or is pending", async () => {
    const [summary] = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        const runId = yield* runs.insert(
          { ...NEW_RUN, plan: SIGNALLED_PLAN, entryStepIds: ["review"] },
          AT,
        );
        yield* runs.start(runId, AT);
        yield* runs.finishStep(
          runId,
          { stepId: "review", iteration: 1 },
          { status: "completed", output: {} },
          TIMES,
        );
        return yield* listRuns({});
      }).pipe(Effect.provide(TestDatabase)),
    );

    expect(locate(summary)).toEqual({
      status: "running",
      activeStepIds: [],
      awaitedSignalIds: ["approved", "merged"],
    });
  });

  it("waits on no signal while a signal that just fired is pending", async () => {
    const [summary] = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        const runId = yield* runs.insert(
          { ...NEW_RUN, plan: SIGNALLED_PLAN, entryStepIds: ["review"] },
          AT,
        );
        yield* runs.start(runId, AT);
        yield* runs.finishStep(
          runId,
          { stepId: "review", iteration: 1 },
          { status: "completed", output: {} },
          TIMES,
        );
        yield* runs.insertSignalStep(runId, { triggerId: "approved", eventId: 7, output: {} }, AT);
        return yield* listRuns({});
      }).pipe(Effect.provide(TestDatabase)),
    );

    expect(locate(summary)).toEqual({
      status: "running",
      activeStepIds: ["approved"],
      awaitedSignalIds: [],
    });
  });

  it("gives neither field to a run that has ended", async () => {
    const [summary] = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        const runId = yield* runs.insert({ ...NEW_RUN, plan: SIGNALLED_PLAN }, AT);
        yield* runs.start(runId, AT);
        yield* runs.finish(runId, { status: "completed" }, AT);
        return yield* listRuns({});
      }).pipe(Effect.provide(TestDatabase)),
    );

    expect(summary?.status).toBe("completed");
    expect(summary).not.toHaveProperty("activeStepIds");
    expect(summary).not.toHaveProperty("awaitedSignalIds");
  });
});

describe("activeSince", () => {
  it("keeps the runs live at some moment of a day, whenever they were created", async () => {
    const [kept, listed] = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        const insertRun = (createdAt: string, finishedAt: string | undefined) =>
          Effect.gen(function* () {
            const runId = yield* runs.insert(NEW_RUN, createdAt);
            yield* runs.start(runId, createdAt);
            if (finishedAt !== undefined)
              yield* runs.finish(runId, { status: "completed" }, finishedAt);
            return runId;
          });
        const endedInTheDay = yield* insertRun(
          "2026-10-06T09:00:00.000Z",
          "2026-10-09T10:00:00.000Z",
        );
        const stillLive = yield* insertRun("2026-10-06T09:30:00.000Z", undefined);
        const createdInTheDay = yield* insertRun(
          "2026-10-09T12:00:00.000Z",
          "2026-10-09T12:05:00.000Z",
        );
        // Ended the day before, so not live on the day.
        yield* insertRun("2026-10-06T10:00:00.000Z", "2026-10-08T23:59:59.999Z");
        // Live now, but created after the day.
        yield* insertRun("2026-10-10T08:00:00.000Z", undefined);
        const listed = yield* listRuns({
          activeSince: "2026-10-09T00:00:00.000Z",
          until: "2026-10-09T23:59:59.999Z",
        });
        return [[createdInTheDay, stillLive, endedInTheDay], listed] as const;
      }).pipe(Effect.provide(TestDatabase)),
    );

    expect(listed.map((summary) => summary.id)).toEqual(kept);
  });
});
