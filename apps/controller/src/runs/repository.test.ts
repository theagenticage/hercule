/**
 * Tests the run repository against a migrated test database:
 *
 * - the guard on ending a step record: a record that has already ended
 *   cannot be ended again. The run engine ends a record in the same
 *   transaction as its action's effect, so the failure is what rolls that
 *   effect back when something else, such as a cancellation, ended the record
 *   first;
 * - the run a re-run names in `originalRunId`, as it is written, read back
 *   and filtered on;
 * - the Task a handed-off run works on in `taskId`, as it is written, read
 *   back and listed on a run summary;
 * - where a running run's summary says the run is: its active steps and the
 *   signals it waits on;
 * - the `activeSince` filter, which keeps the runs that had not ended before
 *   an instant;
 * - the `newestPerWorkflow` filter, which keeps each workflow's newest runs;
 * - the query plans of the run list's own SQL: a day's read, the list of
 *   running runs and each workflow's newest runs each search an index, never
 *   walk every run.
 */
import { describe, expect, it } from "vitest";
import { Effect, Exit, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";
import { inTransaction, TestDatabase } from "../db/testing";
import type { RunFilter, RunSummary, WorkflowDefinition } from "@hercule/contract";
import { mintUuid, uuidFromString, uuidToString } from "../db";
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
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
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
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
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
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
    );

    expect(listed.items.map((summary) => summary.id)).toEqual(rerunIds);
    expect(listed.nextCursor).toBeUndefined();
  });
});

describe("taskId", () => {
  const TASK = "0190c000-0000-7000-8000-0000000000a1";

  it("reads back the Task a run works on, on the run and on its summary, and leaves the field out for a run with none", async () => {
    const [onTask, withoutTask, summaries] = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        const onTaskId = yield* runs.insert({ ...NEW_RUN, taskId: TASK }, AT);
        const withoutTaskId = yield* runs.insert(NEW_RUN, AT);
        return [
          Option.getOrThrow(yield* runs.read(onTaskId)),
          Option.getOrThrow(yield* runs.read(withoutTaskId)),
          yield* listRuns({}),
        ] as const;
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
    );

    expect(onTask.taskId).toBe(TASK);
    expect(withoutTask).not.toHaveProperty("taskId");
    expect(summaries.map((summary) => summary.taskId).sort()).toEqual([TASK, undefined]);
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
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
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
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
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
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
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
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
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
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
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
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
    );

    expect(listed.map((summary) => summary.id)).toEqual(kept);
  });

  it("keeps a run that ended exactly at the instant", async () => {
    const [runId, listed] = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        const runId = yield* runs.insert(NEW_RUN, "2026-10-08T09:00:00.000Z");
        yield* runs.start(runId, "2026-10-08T09:00:00.000Z");
        yield* runs.finish(runId, { status: "completed" }, "2026-10-09T00:00:00.000Z");
        return [runId, yield* listRuns({ activeSince: "2026-10-09T00:00:00.000Z" })] as const;
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
    );

    expect(listed.map((summary) => summary.id)).toEqual([runId]);
  });

  it("pages through the kept runs in both directions with a cursor", async () => {
    const [kept, newestFirst, oldestFirst] = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        const kept: Array<string> = [];
        for (let minute = 0; minute < 5; minute++) {
          const at = `2026-10-09T10:0${minute}:00.000Z`;
          const runId = yield* runs.insert(NEW_RUN, at);
          // Every other run stays live; the rest end within the day.
          if (minute % 2 === 1) {
            yield* runs.start(runId, at);
            yield* runs.finish(runId, { status: "completed" }, "2026-10-09T11:00:00.000Z");
          }
          kept.push(runId);
        }
        // Ended before the instant, so never on any page.
        const ended = yield* runs.insert(NEW_RUN, "2026-10-08T10:00:00.000Z");
        yield* runs.start(ended, "2026-10-08T10:00:00.000Z");
        yield* runs.finish(ended, { status: "completed" }, "2026-10-08T11:00:00.000Z");
        const listAllPages = (direction: "asc" | "desc") =>
          Effect.gen(function* () {
            const ids: Array<string> = [];
            let cursor: string | undefined;
            do {
              const page = yield* runs.list({
                activeSince: "2026-10-09T00:00:00.000Z",
                limit: 2,
                cursor,
                direction,
              });
              ids.push(...page.items.map((summary) => summary.id));
              cursor = page.nextCursor;
            } while (cursor !== undefined);
            return ids;
          });
        return [kept, yield* listAllPages("desc"), yield* listAllPages("asc")] as const;
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
    );

    expect(newestFirst).toEqual([...kept].reverse());
    expect(oldestFirst).toEqual(kept);
  });
});

/**
 * Inserts a stored workflow with its id and nothing else of use, and returns
 * the id. The run list reads only a workflow's id, so the definition stays
 * empty.
 */
const insertWorkflow = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const id = uuidToString(mintUuid());
  yield* sql`
    INSERT INTO workflows (id, source, definition, enabled, created_at, updated_at)
    VALUES (${uuidFromString(id)}, '', '{}', 1, ${AT}, ${AT})
  `;
  return id;
});

/** Inserts a run of the workflow, created at the minute after 10:00, and returns its id. */
const insertRunAt = (workflowId: string | null, minute: number) =>
  Effect.flatMap(runRepository, (runs) =>
    runs.insert(
      { ...NEW_RUN, workflowId },
      `2026-10-09T10:${String(minute).padStart(2, "0")}:00.000Z`,
    ),
  );

describe("newestPerWorkflow", () => {
  it("keeps each workflow's newest runs, at most the cap each, and leaves out sent runs", async () => {
    const [kept, listed] = await Effect.runPromise(
      Effect.gen(function* () {
        const busy = yield* insertWorkflow;
        const quiet = yield* insertWorkflow;
        const busyRuns = [];
        for (let minute = 0; minute < 4; minute++) busyRuns.push(yield* insertRunAt(busy, minute));
        const quietRun = yield* insertRunAt(quiet, 1);
        // A run of a sent workflow, newer than every other run.
        yield* insertRunAt(null, 9);
        const listed = yield* listRuns({ newestPerWorkflow: 2 });
        return [[busyRuns[3], busyRuns[2], quietRun], listed] as const;
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
    );

    expect(listed.map((summary) => summary.id)).toEqual(kept);
  });

  it("leaves out the runs of a deleted workflow, which keep its id", async () => {
    const listed = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const deleted = yield* insertWorkflow;
        yield* insertRunAt(deleted, 0);
        yield* sql`DELETE FROM workflows WHERE id = ${uuidFromString(deleted)}`;
        return yield* listRuns({ newestPerWorkflow: 5 });
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
    );

    expect(listed).toEqual([]);
  });

  it("ranks only the runs the other filters keep", async () => {
    const [kept, listed] = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        const workflow = yield* insertWorkflow;
        const other = yield* insertWorkflow;
        const older = yield* insertRunAt(workflow, 0);
        const newer = yield* insertRunAt(workflow, 1);
        // The two newest runs of the workflow, both completed.
        for (const minute of [2, 3]) {
          const runId = yield* insertRunAt(workflow, minute);
          yield* runs.start(runId, AT);
          yield* runs.finish(runId, { status: "completed" }, AT);
        }
        yield* insertRunAt(other, 4);
        const listed = yield* listRuns({
          newestPerWorkflow: 2,
          status: "pending",
          workflowId: workflow,
        });
        return [[newer, older], listed] as const;
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
    );

    expect(listed.map((summary) => summary.id)).toEqual(kept);
  });

  it("ranks only the runs live since activeSince", async () => {
    const [kept, listed] = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        const workflow = yield* insertWorkflow;
        const live = yield* insertRunAt(workflow, 0);
        // The newest run of the workflow, ended before the instant.
        const ended = yield* insertRunAt(workflow, 1);
        yield* runs.start(ended, AT);
        yield* runs.finish(ended, { status: "completed" }, "2026-10-09T10:30:00.000Z");
        const listed = yield* listRuns({
          newestPerWorkflow: 1,
          activeSince: "2026-10-09T11:00:00.000Z",
        });
        return [live, listed] as const;
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
    );

    expect(listed.map((summary) => summary.id)).toEqual([kept]);
  });

  it("finds a workflow's running run behind a long history of ended runs", async () => {
    const [kept, listed] = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        const busy = yield* insertWorkflow;
        const running = yield* insertRunAt(busy, 0);
        yield* runs.start(running, AT);
        for (let minute = 1; minute < 60; minute++) {
          const ended = yield* insertRunAt(busy, minute);
          yield* runs.start(ended, AT);
          yield* runs.finish(ended, { status: "completed" }, "2026-10-09T11:00:00.000Z");
        }
        const listed = yield* listRuns({ newestPerWorkflow: 2, status: "running" });
        return [running, listed] as const;
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
    );

    expect(listed.map((summary) => summary.id)).toEqual([kept]);
  });

  it("breaks a tie on the creation time by the greater id", async () => {
    const [kept, listed] = await Effect.runPromise(
      Effect.gen(function* () {
        const workflow = yield* insertWorkflow;
        const first = yield* insertRunAt(workflow, 0);
        const second = yield* insertRunAt(workflow, 0);
        const listed = yield* listRuns({ newestPerWorkflow: 1 });
        return [first > second ? first : second, listed] as const;
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
    );

    expect(listed.map((summary) => summary.id)).toEqual([kept]);
  });

  it("pages through the same runs in both directions with a cursor", async () => {
    const [unpaged, newestFirst, oldestFirst] = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        for (let workflow = 0; workflow < 3; workflow++) {
          const workflowId = yield* insertWorkflow;
          for (let minute = 0; minute < 3; minute++) {
            yield* insertRunAt(workflowId, workflow * 10 + minute);
          }
        }
        const listAllPages = (direction: "asc" | "desc") =>
          Effect.gen(function* () {
            const ids: Array<string> = [];
            let cursor: string | undefined;
            do {
              const page = yield* runs.list({ newestPerWorkflow: 2, limit: 4, cursor, direction });
              ids.push(...page.items.map((summary) => summary.id));
              cursor = page.nextCursor;
            } while (cursor !== undefined);
            return ids;
          });
        const unpaged = (yield* listRuns({ newestPerWorkflow: 2 })).map((summary) => summary.id);
        return [unpaged, yield* listAllPages("desc"), yield* listAllPages("asc")] as const;
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
    );

    expect(unpaged).toHaveLength(6);
    expect(newestFirst).toEqual(unpaged);
    expect(oldestFirst).toEqual([...unpaged].reverse());
  });
});

/**
 * Returns the query plan SQLite chooses for the first statement the run list
 * sends for `filter`: the read of the page's runs. The statement is captured
 * as the repository builds it, so the plan is the plan of the real query.
 * An empty database is enough: with no statistics gathered by `ANALYZE`,
 * SQLite chooses a plan without regard to how many rows a table holds.
 */
const explainListQuery = (filter: RunFilter) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const runs = yield* runRepository;
      const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
      yield* runs.list({ ...filter, limit: 50, cursor: undefined, direction: "desc" }).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) =>
          Effect.sync(() => {
            statements.push(statement.compile());
            return statement;
          }),
        ),
      );
      const [text, params] = statements.find(([text]) => text.includes("FROM")) ?? ["", []];
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${text}`,
        params,
      );
      return plan.map((row) => row.detail).join(" / ");
    }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
  );

describe("the run list's query plans", () => {
  const DAY = { activeSince: "2026-10-09T00:00:00.000Z", until: "2026-10-09T23:59:59.999Z" };

  it("finds one workflow's runs live during a day with two lookups on runs_workflow_finished", async () => {
    const plan = await explainListQuery({
      ...DAY,
      workflowId: "0190c000-0000-7000-8000-000000000001",
    });

    expect(plan).toContain("runs_workflow_finished (workflow_id=? AND finished_at=?)");
    expect(plan).toContain("runs_workflow_finished (workflow_id=? AND finished_at>?)");
    expect(plan).not.toMatch(/runs_workflow\b(?!_finished)/);
  });

  it("finds the runs of every workflow live during a day with two lookups on runs_finished", async () => {
    const plan = await explainListQuery(DAY);

    expect(plan).toContain("runs_finished (finished_at=?)");
    expect(plan).toContain("runs_finished (finished_at>?)");
    expect(plan).not.toContain("SCAN runs");
  });

  it("finds each workflow's newest runs with one short lookup per workflow on runs_workflow", async () => {
    const plan = await explainListQuery({ newestPerWorkflow: 20 });

    expect(plan).toContain("SCAN workflows");
    expect(plan).toContain("runs_workflow (workflow_id=?)");
    expect(plan).not.toContain("SCAN runs");
    // One sort, of the page's runs. A second would mean each workflow's runs
    // are sorted before the lookup stops, which reads all of them.
    expect(plan.match(/TEMP B-TREE/g)).toHaveLength(1);
  });

  it("reads since and until as a range of runs_workflow in each workflow's lookup", async () => {
    const plan = await explainListQuery({
      newestPerWorkflow: 20,
      since: "2026-10-09T00:00:00.000Z",
      until: "2026-10-09T23:59:59.999Z",
    });

    expect(plan).toContain("runs_workflow (workflow_id=? AND created_at>? AND created_at<?)");
    expect(plan).not.toContain("SCAN runs");
  });

  // Each of these filters has an index of its own. A lookup per workflow on
  // runs_workflow would instead read every run of a workflow with a long
  // history of runs the filter refuses.
  it.each([
    ["running runs", { status: "running" }, "runs_unfinished (status=?)"],
    [
      "runs live since an instant",
      { activeSince: "2026-10-09T00:00:00.000Z" },
      "runs_finished (finished_at>?)",
    ],
    [
      "re-runs",
      { originalRunId: "0190c000-0000-7000-8000-000000000001" },
      "runs_original_run_id (original_run_id=?)",
    ],
  ] as const)(
    "finds each workflow's newest %s through the filter's own index, not runs_workflow",
    async (_, filter, index) => {
      const plan = await explainListQuery({ ...filter, newestPerWorkflow: 20 });

      expect(plan).toContain(index);
      expect(plan).not.toContain("runs_workflow");
      expect(plan).not.toContain("SCAN runs");
    },
  );

  it.each([
    ["running runs", { status: "running" }, "runs_unfinished (status=?)"],
    [
      "running runs a user started",
      { status: "running", actor: "user" },
      "runs_unfinished (status=?)",
    ],
    [
      "re-runs",
      { originalRunId: "0190c000-0000-7000-8000-000000000001" },
      "runs_original_run_id (original_run_id=?)",
    ],
  ] as const)(
    "finds one workflow's newest %s through the filter's own index, not runs_workflow",
    async (_, filter, index) => {
      const plan = await explainListQuery({
        ...filter,
        newestPerWorkflow: 20,
        workflowId: "0190c000-0000-7000-8000-000000000002",
      });

      expect(plan).toContain(index);
      expect(plan).not.toContain("runs_workflow");
      expect(plan).not.toContain("SCAN runs");
    },
  );

  it("finds the running runs with runs_unfinished", async () => {
    const plan = await explainListQuery({ status: "running" });

    expect(plan).toContain("runs_unfinished (status=?)");
    expect(plan).not.toContain("SCAN runs");
  });
});

describe("the newest runs of some Tasks", () => {
  const TASK = "0190c000-0000-7000-8000-0000000000b1";
  const OTHER_TASK = "0190c000-0000-7000-8000-0000000000b2";
  const NO_RUN_TASK = "0190c000-0000-7000-8000-0000000000b3";
  const minute = (n: number) => `2026-09-24T10:${String(n).padStart(2, "0")}:00.000Z`;

  it("returns a Task's newest run and all its live runs, whatever the Task's history holds", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        // Many ended runs, then a live one that is not the newest, then the
        // newest run, which ended.
        const ended: Array<string> = [];
        for (let n = 1; n <= 20; n++) {
          const id = yield* runs.insert({ ...NEW_RUN, taskId: TASK }, minute(n));
          yield* runs.finish(id, { status: "completed" }, minute(n));
          ended.push(id);
        }
        const pending = yield* runs.insert({ ...NEW_RUN, taskId: TASK }, minute(21));
        // A second live run of the same Task, older than the first.
        const running = yield* runs.insert(
          { ...NEW_RUN, taskId: TASK },
          "2026-09-24T09:00:00.000Z",
        );
        yield* runs.start(running, "2026-09-24T09:00:00.000Z");
        const newest = yield* runs.insert({ ...NEW_RUN, taskId: TASK }, minute(22));
        yield* runs.finish(newest, { status: "cancelled", keepWorkspace: false }, minute(22));
        const other = yield* runs.insert({ ...NEW_RUN, taskId: OTHER_TASK }, minute(5));
        // A run of a Task that was not asked for, and a run of no Task.
        yield* runs.insert(
          { ...NEW_RUN, taskId: "0190c000-0000-7000-8000-0000000000b4" },
          minute(30),
        );
        yield* runs.insert(NEW_RUN, minute(31));
        const found = yield* runs.listLatestOfTasks([TASK, OTHER_TASK, NO_RUN_TASK]);
        return { found, pending, running, newest, other };
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
    );

    const byTask = new Map(result.found.latest.map((run) => [run.taskId, run]));
    expect(byTask.get(TASK)).toMatchObject({ id: result.newest, status: "cancelled" });
    expect(byTask.get(OTHER_TASK)).toMatchObject({ id: result.other, status: "pending" });
    expect(byTask.has(NO_RUN_TASK)).toBe(false);
    expect(result.found.latest).toHaveLength(2);
    // Newest first, every pending and running run of the asked Tasks (two of
    // the first Task's), and no other.
    expect(result.found.live.map((run) => run.id)).toEqual([
      result.pending,
      result.other,
      result.running,
    ]);
  });

  it("breaks a tie between runs created at the same instant by the greater id", async () => {
    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        const first = yield* runs.insert({ ...NEW_RUN, taskId: TASK }, AT);
        const second = yield* runs.insert({ ...NEW_RUN, taskId: TASK }, AT);
        const latest = (yield* runs.listLatestOfTasks([TASK])).latest;
        return { ids: [first, second].toSorted(), latest };
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
    );

    expect(found.latest.map((run) => run.id)).toEqual([found.ids[1]]);
  });

  it("returns nothing for no Tasks", async () => {
    const found = await Effect.runPromise(
      Effect.flatMap(runRepository, (runs) => runs.listLatestOfTasks([])).pipe(
        inTransaction,
        Effect.provide(TestDatabase),
      ),
    );

    expect(found).toEqual({ latest: [], live: [] });
  });

  it("says where a running run is, as the run list does", async () => {
    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        const id = yield* runs.insert({ ...NEW_RUN, plan: SIGNALLED_PLAN, taskId: TASK }, AT);
        yield* runs.start(id, AT);
        yield* runs.startStep(id, { stepId: "create", iteration: 1 }, undefined, AT);
        yield* runs.finishStep(
          id,
          { stepId: "create", iteration: 1 },
          { status: "completed", output: {} },
          TIMES,
        );
        return (yield* runs.listLatestOfTasks([TASK])).latest;
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
    );

    expect(found).toMatchObject([
      { status: "running", activeStepIds: [], awaitedSignalIds: ["approved", "merged"] },
    ]);
  });

  it("finds what went wrong in a failed run: its message, else its failed step's error", async () => {
    const messages = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        const validation = yield* runs.insert({ ...NEW_RUN, taskId: TASK }, minute(1));
        yield* runs.finish(
          validation,
          {
            status: "failed",
            failureReason: "validation-error",
            failureMessage: "the inputs do not fit",
          },
          minute(1),
        );
        const stepFailure = yield* runs.insert({ ...NEW_RUN, taskId: TASK }, minute(2));
        const step = { stepId: "create", iteration: 1 };
        yield* runs.startStep(stepFailure, step, undefined, minute(2));
        yield* runs.finishStep(
          stepFailure,
          step,
          { status: "failed", error: { code: "denied", message: "permission denied on ops-db" } },
          { startedAt: minute(2), finishedAt: minute(2) },
        );
        yield* runs.finish(
          stepFailure,
          { status: "failed", failureReason: "step-failed", failedStepId: "create" },
          minute(2),
        );
        const workspace = yield* runs.insert({ ...NEW_RUN, taskId: TASK }, minute(3));
        yield* runs.finish(
          workspace,
          { status: "failed", failureReason: "workspace-failed" },
          minute(3),
        );
        const completed = yield* runs.insert({ ...NEW_RUN, taskId: TASK }, minute(4));
        yield* runs.finish(completed, { status: "completed" }, minute(4));
        const found = yield* runs.listFailureMessages([
          validation,
          stepFailure,
          workspace,
          completed,
        ]);
        return { found, validation, stepFailure };
      }).pipe(inTransaction, Effect.provide(TestDatabase)),
    );

    // The workspace failure records no message, and the completed run failed at nothing.
    expect([...messages.found.entries()].toSorted()).toEqual(
      [
        [messages.validation, "the inputs do not fit"],
        [messages.stepFailure, "permission denied on ops-db"],
      ].toSorted(),
    );
  });
});

/**
 * Runs `read` against an empty database and returns the plan of the statement
 * it runs whose text includes `fragment`, as one line per step. An empty
 * database is enough, as for the run list's plans: without `ANALYZE`, SQLite
 * chooses the plan without regard to how many rows a table holds.
 */
const explainStatement = (
  fragment: string,
  read: (runs: Effect.Success<typeof runRepository>) => Effect.Effect<unknown, unknown>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const runs = yield* runRepository;
      const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
      yield* read(runs).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) =>
          Effect.sync(() => {
            statements.push(statement.compile());
            return statement;
          }),
        ),
      );
      const [text, params] = statements.find(([text]) => text.includes(fragment)) ?? ["", []];
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${text}`,
        params,
      );
      return plan.map((row) => row.detail);
    }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
  );

describe("the query plans of the newest runs of some Tasks", () => {
  const TASKS = ["0190c000-0000-7000-8000-0000000000b1", "0190c000-0000-7000-8000-0000000000b2"];

  it("looks up each Task's newest run on runs_task_id and reads the run by its key, with no sort and no scan of runs", async () => {
    const plan = await explainStatement("latest_id", (runs) => runs.listLatestOfTasks(TASKS));

    expect(plan).toContain("SEARCH runs USING COVERING INDEX runs_task_id (task_id=?)");
    expect(plan).toContain("SEARCH runs USING INDEX sqlite_autoindex_runs_1 (id=?)");
    expect(plan.some((step) => step.includes("TEMP B-TREE"))).toBe(false);
    expect(plan.some((step) => step.startsWith("SCAN runs"))).toBe(false);
  });

  it("finds the live runs on runs_unfinished, not by a scan of runs", async () => {
    const plan = await explainStatement("status IN", (runs) => runs.listLatestOfTasks(TASKS));

    expect(plan).toContain("SEARCH runs USING INDEX runs_unfinished (status=?)");
    expect(plan.some((step) => step.startsWith("SCAN runs"))).toBe(false);
  });

  it("looks the failed runs up by key, and each failed step's record by its key, with no sort", async () => {
    const plan = await explainStatement("run_steps", (runs) =>
      runs.listFailureMessages(["0190c000-0000-7000-8000-0000000000c1"]),
    );

    expect(plan).toContain("SEARCH runs USING INDEX sqlite_autoindex_runs_1 (id=?)");
    expect(plan).toContain(
      "SEARCH s USING INDEX sqlite_autoindex_run_steps_1 (run_id=? AND step_id=?)",
    );
    expect(plan.some((step) => step.startsWith("SCAN"))).toBe(false);
    expect(plan.some((step) => step.includes("TEMP B-TREE"))).toBe(false);
  });
});
