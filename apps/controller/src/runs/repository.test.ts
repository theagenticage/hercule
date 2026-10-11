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
import { TestDatabase } from "../db/testing";
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

  it("keeps a run that ended exactly at the instant", async () => {
    const [runId, listed] = await Effect.runPromise(
      Effect.gen(function* () {
        const runs = yield* runRepository;
        const runId = yield* runs.insert(NEW_RUN, "2026-10-08T09:00:00.000Z");
        yield* runs.start(runId, "2026-10-08T09:00:00.000Z");
        yield* runs.finish(runId, { status: "completed" }, "2026-10-09T00:00:00.000Z");
        return [runId, yield* listRuns({ activeSince: "2026-10-09T00:00:00.000Z" })] as const;
      }).pipe(Effect.provide(TestDatabase)),
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
      }).pipe(Effect.provide(TestDatabase)),
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
      }).pipe(Effect.provide(TestDatabase)),
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
      }).pipe(Effect.provide(TestDatabase)),
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
      }).pipe(Effect.provide(TestDatabase)),
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
      }).pipe(Effect.provide(TestDatabase)),
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
      }).pipe(Effect.provide(TestDatabase)),
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
      }).pipe(Effect.provide(TestDatabase)),
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
      }).pipe(Effect.provide(TestDatabase)),
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
    }).pipe(Effect.provide(TestDatabase), Effect.orDie),
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
