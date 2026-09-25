/**
 * Integration tests for how a run routes between its steps, driven over HTTP
 * against a real controller: edge conditions, step conditions and the skips
 * they cause, `join: any` and `join: all`, loops capped by `maxTraversals`,
 * and the expression errors a condition can fail a run with.
 *
 * Each fixture is a small workflow of built-in actions. A run is started,
 * polled until it finishes, and read back: which step records exist, with
 * which iteration and status, what the run's failure names, and how often it
 * followed each edge. `waitForRunToFinish` also checks every read against the
 * rules every run keeps, such as statuses only moving forward.
 *
 * Several fixtures loop with `task.query`: the `file` step creates a task
 * labelled `loop`, the `count` step lists the tasks with that label, and the
 * edge back to `file` is followed while the count is below the `target`
 * input. So the loop goes round a known number of times, decided by the input.
 *
 * No runner is connected: action steps run on the controller.
 */
import { describe, expect, it, vi } from "vitest";
import type { Run, StepRecord } from "@hercule/contract";
import { WAIT_DEADLINE_MS } from "../../sessions/testing";
import { createWorkflowOrFail, withSetUpController } from "../../workflows/testing";
import {
  buildCreateStep,
  expectStatus,
  findStepRecords,
  listTasks,
  startRun,
  waitForRunToFinish,
} from "./testing";

/** Long enough for a run with a `wait` step, and for the fixtures that run twice. */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS + 20_000 });

/** Returns each record of the run as `[stepId, iteration, status]`, sorted, for comparing whole runs. */
const listRecordSummaries = (run: Run): ReadonlyArray<readonly [string, number, string]> =>
  run.steps
    .map((record) => [record.stepId, record.iteration, record.status] as const)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

/** Returns the statuses of one step's records, in iteration order. */
const listStatuses = (run: Run, stepId: string): ReadonlyArray<string> =>
  [...findStepRecords(run, stepId)]
    .sort((left, right) => left.iteration - right.iteration)
    .map((record) => record.status);

/** Returns the title of the task a completed `task.create` record returned. */
const readCreatedTitle = (record: StepRecord | undefined): string =>
  (expectStatus(record, "completed").output as { readonly title: string }).title;

/** Saves `definition`, runs it with `inputs`, and returns the finished run. */
const runToEnd = async (
  base: string,
  token: string,
  definition: unknown,
  inputs: Record<string, unknown> = {},
): Promise<Run> => {
  const workflow = await createWorkflowOrFail(base, token, { definition });
  return waitForRunToFinish(base, token, await startRun(base, token, workflow.id, { inputs }));
};

/** A step that waits `seconds` with the built-in `wait` action. */
const buildWaitStep = (id: string, seconds: number) => ({
  id,
  kind: "action",
  action: "wait",
  params: { seconds },
});

/** How many tasks labelled `loop` the `count` step found, as a CEL expression. */
const COUNTED = "size(steps.count.output.items)";

/**
 * The counting loop, with the edges in this order:
 *
 * - 0: `file` -> `count`;
 * - 1: `count` -> `log`, followed every time `count` completes;
 * - 2: `count` -> `file` while the count is below `target`, capped at
 *   `maxTraversals`;
 * - 3: `count` -> `done` once the count reaches `target`.
 *
 * `file` is an entry step although an edge leads into it, because the run
 * begins inside the loop. `done` creates a task titled with the count it read.
 */
const buildCountingLoop = (maxTraversals: number) => ({
  name: "Count to the target",
  inputs: [{ name: "target", schema: { type: "integer", minimum: 1 }, required: true }],
  steps: [
    {
      id: "file",
      kind: "action",
      action: "task.create",
      entry: true,
      params: { title: "A loop task", description: "", labels: ["loop"] },
    },
    { id: "count", kind: "action", action: "task.query", params: { labels: ["loop"] } },
    buildCreateStep("log"),
    {
      id: "done",
      kind: "action",
      action: "task.create",
      params: { title: `Counted {{ ${COUNTED} }}`, description: "" },
    },
  ],
  edges: [
    { from: "file", to: "count" },
    { from: "count", to: "log" },
    { from: "count", to: "file", condition: `${COUNTED} < inputs.target`, maxTraversals },
    { from: "count", to: "done", condition: `${COUNTED} >= inputs.target` },
  ],
});

/* ------------------------------------------------------------------------ */
/* Edge conditions.                                                          */
/* ------------------------------------------------------------------------ */

describe("an edge condition", () => {
  /**
   * `review` leads to `merge` when the `approve` input is true, to `fix`
   * when it is false, and to `notify` always. The edge to `merge` also reads
   * `review`'s output.
   */
  const BRANCH_DEFINITION = {
    name: "Branch on approval",
    inputs: [{ name: "approve", schema: { type: "boolean" }, required: true }],
    steps: [
      buildCreateStep("review"),
      buildCreateStep("merge"),
      buildCreateStep("fix"),
      buildCreateStep("notify"),
    ],
    edges: [
      {
        from: "review",
        to: "merge",
        condition: 'inputs.approve && steps.review.output.title == "File the review task"',
      },
      { from: "review", to: "fix", condition: "!inputs.approve" },
      { from: "review", to: "notify" },
    ],
  };

  it("fires when it is true or absent, and does not fire when it is false, reading inputs and step outputs", async () => {
    await withSetUpController(async ({ base, token }) => {
      const approved = await runToEnd(base, token, BRANCH_DEFINITION, { approve: true });
      expect(approved.status, JSON.stringify(approved)).toBe("completed");
      expect(listRecordSummaries(approved)).toEqual([
        ["merge", 1, "completed"],
        ["notify", 1, "completed"],
        ["review", 1, "completed"],
      ]);

      const rejected = await runToEnd(base, token, BRANCH_DEFINITION, { approve: false });
      expect(rejected.status, JSON.stringify(rejected)).toBe("completed");
      expect(listRecordSummaries(rejected)).toEqual([
        ["fix", 1, "completed"],
        ["notify", 1, "completed"],
        ["review", 1, "completed"],
      ]);
    });
  });

  it("reads the latest finished iteration of a step as steps.<id>", async () => {
    await withSetUpController(async ({ base, token }) => {
      const run = await runToEnd(base, token, buildCountingLoop(5), { target: 3 });

      expect(run.status, JSON.stringify(run)).toBe("completed");
      expect(listStatuses(run, "count")).toEqual(["completed", "completed", "completed"]);
      // `done` is reached only when the latest count is 3, and its title
      // reads the latest count, not the first.
      expect(readCreatedTitle(findStepRecords(run, "done")[0])).toBe("Counted 3");
    });
  });

  it("sees a dead step and a step that has not run yet as absent, so a has() guard passes", async () => {
    await withSetUpController(async ({ base, token }) => {
      const run = await runToEnd(base, token, {
        name: "Guards",
        steps: [
          buildCreateStep("start"),
          buildCreateStep("never"),
          buildCreateStep("after_never"),
          buildCreateStep("check"),
          buildCreateStep("later"),
        ],
        edges: [
          { from: "start", to: "never", condition: "false" },
          { from: "never", to: "after_never" },
          {
            from: "start",
            to: "check",
            condition: "!has(steps.never) && !has(steps.after_never) && !has(steps.later)",
          },
          { from: "check", to: "later" },
        ],
      });

      expect(run.status, JSON.stringify(run)).toBe("completed");
      expect(listRecordSummaries(run)).toEqual([
        ["check", 1, "completed"],
        ["later", 1, "completed"],
        ["start", 1, "completed"],
      ]);
    });
  });

  it("sees a step whose latest iteration was skipped as absent, even though an earlier iteration completed", async () => {
    await withSetUpController(async ({ base, token }) => {
      // `review` runs in the first round, when the count is 1, and is skipped
      // in the second, when the count is 2. Its edges then pass through, and
      // only the edge that finds `review` absent may fire.
      const run = await runToEnd(base, token, {
        name: "A skipped latest iteration",
        steps: [
          {
            id: "file",
            kind: "action",
            action: "task.create",
            entry: true,
            params: { title: "A loop task", description: "", labels: ["loop"] },
          },
          { id: "count", kind: "action", action: "task.query", params: { labels: ["loop"] } },
          buildCreateStep("review", { condition: `${COUNTED} == 1` }),
          buildCreateStep("review_absent"),
          buildCreateStep("review_present"),
        ],
        edges: [
          { from: "file", to: "count" },
          { from: "count", to: "review" },
          { from: "review", to: "file", condition: `${COUNTED} < 2`, maxTraversals: 3 },
          {
            from: "review",
            to: "review_absent",
            condition: `${COUNTED} >= 2 && !has(steps.review)`,
          },
          {
            from: "review",
            to: "review_present",
            condition: `${COUNTED} >= 2 && has(steps.review)`,
          },
        ],
      });

      expect(run.status, JSON.stringify(run)).toBe("completed");
      expect(listStatuses(run, "review")).toEqual(["completed", "skipped"]);
      expect(listStatuses(run, "review_absent")).toEqual(["completed"]);
      expect(findStepRecords(run, "review_present")).toEqual([]);
    });
  });

  it("fails the run with expression-error when it reads a dead step without a has() guard", async () => {
    await withSetUpController(async ({ base, token }) => {
      const run = await runToEnd(base, token, {
        name: "An unguarded read",
        steps: [buildCreateStep("start"), buildCreateStep("never"), buildCreateStep("check")],
        edges: [
          { from: "start", to: "never", condition: "false" },
          { from: "start", to: "check", condition: 'steps.never.output.id != ""' },
        ],
      });

      const failed = expectStatus(run, "failed");
      expect(failed).toMatchObject({
        failureReason: "expression-error",
        failedStepId: "start",
        failedEdge: { index: 1 },
      });
      expect(findStepRecords(run, "check")).toEqual([]);
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Expression errors in conditions.                                          */
/* ------------------------------------------------------------------------ */

describe("a condition that cannot be decided", () => {
  /** A condition that throws, and one that gives a string. */
  const UNDECIDABLE_CONDITIONS = [
    ["throws", "steps.start.output.no_such_field == 1"],
    ["gives a non-boolean", "steps.start.output.title"],
  ] as const;

  it.each(UNDECIDABLE_CONDITIONS)(
    "at an edge that %s fails the run at the edge's source and index, and cancels the record an earlier edge created",
    async (_description, condition) => {
      await withSetUpController(async ({ base, token }) => {
        const run = await runToEnd(base, token, {
          name: "A broken edge condition",
          steps: [buildCreateStep("start"), buildCreateStep("first"), buildCreateStep("second")],
          edges: [
            { from: "start", to: "first" },
            { from: "start", to: "second", condition },
          ],
        });

        const failed = expectStatus(run, "failed");
        expect(failed).toMatchObject({
          failureReason: "expression-error",
          failedStepId: "start",
          failedEdge: { index: 1 },
        });
        expect(listStatuses(run, "start")).toEqual(["completed"]);
        // Edge 0 fired in the same transaction, before edge 1 failed.
        expect(listStatuses(run, "first")).toEqual(["cancelled"]);
        expect(findStepRecords(run, "second")).toEqual([]);
        expect((await listTasks(base, token)).map((task) => task.title)).toEqual([
          "File the start task",
        ]);
      });
    },
  );

  it("keeps the condition's evaluation error on the run, where run.read returns it", async () => {
    await withSetUpController(async ({ base, token }) => {
      const run = await runToEnd(base, token, {
        name: "A broken edge condition",
        steps: [buildCreateStep("start"), buildCreateStep("next")],
        edges: [{ from: "start", to: "next", condition: UNDECIDABLE_CONDITIONS[0][1] }],
      });

      expect(expectStatus(run, "failed")).toMatchObject({
        failureReason: "expression-error",
        failedEdge: {
          index: 0,
          message: expect.stringContaining("No such key: no_such_field") as unknown,
        },
      });
    });
  });

  it.each(UNDECIDABLE_CONDITIONS)(
    "on a step that %s fails its record with expression_error, fails the run at the step, and cancels the other records",
    async (_description, condition) => {
      await withSetUpController(async ({ base, token }) => {
        const run = await runToEnd(base, token, {
          name: "A broken step condition",
          steps: [
            buildCreateStep("start"),
            buildCreateStep("guarded", { condition }),
            // Pending or still waiting when `guarded` fails, however the
            // engine orders the two.
            buildWaitStep("other", 20),
          ],
          edges: [
            { from: "start", to: "guarded" },
            { from: "start", to: "other" },
          ],
        });

        const failed = expectStatus(run, "failed");
        expect(failed.failureReason).toBe("expression-error");
        expect(failed.failedStepId).toBe("guarded");
        expect("failedEdge" in failed, JSON.stringify(run)).toBe(false);
        const [guarded] = findStepRecords(run, "guarded");
        expect(expectStatus(guarded, "failed").error.code).toBe("expression_error");
        expect(listStatuses(run, "start")).toEqual(["completed"]);
        expect(listStatuses(run, "other")).toEqual(["cancelled"]);
        expect((await listTasks(base, token)).map((task) => task.title)).toEqual([
          "File the start task",
        ]);
      });
    },
  );
});

/* ------------------------------------------------------------------------ */
/* Step conditions and skips.                                                */
/* ------------------------------------------------------------------------ */

describe("a step condition", () => {
  /**
   * `maybe` runs only when the `go` input is true. Its edge to `after` fires
   * only when `maybe` is absent, which is when it was skipped.
   */
  const SKIP_DEFINITION = {
    name: "Skip a step",
    inputs: [{ name: "go", schema: { type: "boolean" }, required: true }],
    steps: [
      buildCreateStep("first"),
      buildCreateStep("maybe", { condition: "inputs.go" }),
      buildCreateStep("after"),
    ],
    edges: [
      { from: "first", to: "maybe" },
      { from: "maybe", to: "after", condition: "!has(steps.maybe)" },
    ],
  };

  it("skips the step when false: the record is skipped with only finishedAt, and its edges pass through as if it had completed", async () => {
    await withSetUpController(async ({ base, token }) => {
      const run = await runToEnd(base, token, SKIP_DEFINITION, { go: false });

      expect(run.status, JSON.stringify(run)).toBe("completed");
      const [maybe] = findStepRecords(run, "maybe");
      const skipped = expectStatus(maybe, "skipped");
      expect(Object.keys(skipped).sort()).toEqual(["finishedAt", "iteration", "status", "stepId"]);
      expect(skipped.iteration).toBe(1);
      expect(listStatuses(run, "after")).toEqual(["completed"]);
      // The skipped step's action never ran.
      expect((await listTasks(base, token)).map((task) => task.title).sort()).toEqual([
        "File the after task",
        "File the first task",
      ]);
    });
  });

  it("runs the step when true, and the downstream !has() guard then does not fire", async () => {
    await withSetUpController(async ({ base, token }) => {
      const run = await runToEnd(base, token, SKIP_DEFINITION, { go: true });

      expect(run.status, JSON.stringify(run)).toBe("completed");
      expect(listRecordSummaries(run)).toEqual([
        ["first", 1, "completed"],
        ["maybe", 1, "completed"],
      ]);
    });
  });
});

/* ------------------------------------------------------------------------ */
/* join: any.                                                                */
/* ------------------------------------------------------------------------ */

describe("join: any", () => {
  it("adds a record with the next iteration for every firing incoming edge, and the step's edges fire per iteration", async () => {
    await withSetUpController(async ({ base, token }) => {
      const run = await runToEnd(base, token, {
        name: "A diamond with join any",
        steps: [
          buildCreateStep("root"),
          buildCreateStep("left"),
          buildCreateStep("right"),
          buildCreateStep("merge"),
          buildCreateStep("after"),
        ],
        edges: [
          { from: "root", to: "left" },
          { from: "root", to: "right" },
          { from: "left", to: "merge" },
          { from: "right", to: "merge" },
          { from: "merge", to: "after" },
        ],
      });

      expect(run.status, JSON.stringify(run)).toBe("completed");
      expect(listRecordSummaries(run)).toEqual([
        ["after", 1, "completed"],
        ["after", 2, "completed"],
        ["left", 1, "completed"],
        ["merge", 1, "completed"],
        ["merge", 2, "completed"],
        ["right", 1, "completed"],
        ["root", 1, "completed"],
      ]);
    });
  });

  it("numbers the records of a step in a loop 1, 2, 3, and the step's edges fire on every round", async () => {
    await withSetUpController(async ({ base, token }) => {
      const run = await runToEnd(base, token, buildCountingLoop(5), { target: 3 });

      expect(run.status, JSON.stringify(run)).toBe("completed");
      for (const stepId of ["file", "count", "log"]) {
        expect(
          findStepRecords(run, stepId).map((record) => [record.iteration, record.status]),
          stepId,
        ).toEqual([
          [1, "completed"],
          [2, "completed"],
          [3, "completed"],
        ]);
      }
      expect(listStatuses(run, "done")).toEqual(["completed"]);
    });
  });
});

/* ------------------------------------------------------------------------ */
/* join: all.                                                                */
/* ------------------------------------------------------------------------ */

describe("join: all", () => {
  /** The step that joins `left` and `right`, titled with both their outputs. */
  const MERGE_STEP = {
    id: "merge",
    kind: "action",
    action: "task.create",
    join: "all",
    params: {
      title: "{{ steps.left.output.title }} and {{ steps.right.output.title }}",
      description: "",
    },
  };

  it("runs once, after both branches of a diamond, and sees both outputs", async () => {
    await withSetUpController(async ({ base, token }) => {
      const run = await runToEnd(base, token, {
        name: "A diamond with join all",
        steps: [
          buildCreateStep("root"),
          buildCreateStep("left"),
          buildCreateStep("right"),
          MERGE_STEP,
          buildCreateStep("after"),
        ],
        edges: [
          { from: "root", to: "left" },
          { from: "root", to: "right" },
          { from: "left", to: "merge" },
          { from: "right", to: "merge" },
          { from: "merge", to: "after" },
        ],
      });

      expect(run.status, JSON.stringify(run)).toBe("completed");
      expect(listRecordSummaries(run)).toEqual([
        ["after", 1, "completed"],
        ["left", 1, "completed"],
        ["merge", 1, "completed"],
        ["right", 1, "completed"],
        ["root", 1, "completed"],
      ]);
      expect(readCreatedTitle(findStepRecords(run, "merge")[0])).toBe(
        "File the left task and File the right task",
      );
    });
  });

  it("waits for the slower branch before it runs", async () => {
    await withSetUpController(async ({ base, token }) => {
      const run = await runToEnd(base, token, {
        name: "A slow branch and a fast one",
        steps: [
          buildCreateStep("root"),
          buildWaitStep("slow", 1),
          buildCreateStep("left"),
          buildCreateStep("right"),
          MERGE_STEP,
        ],
        edges: [
          { from: "root", to: "slow" },
          { from: "slow", to: "left" },
          { from: "root", to: "right" },
          { from: "left", to: "merge" },
          { from: "right", to: "merge" },
        ],
      });

      expect(run.status, JSON.stringify(run)).toBe("completed");
      const merges = findStepRecords(run, "merge");
      expect(merges.map((record) => [record.iteration, record.status])).toEqual([[1, "completed"]]);
      const mergeStartedAt = expectStatus(merges[0], "completed").startedAt;
      for (const source of ["left", "right"]) {
        const finishedAt = expectStatus(findStepRecords(run, source)[0], "completed").finishedAt;
        expect(mergeStartedAt >= finishedAt, `merge started before ${source} finished`).toBe(true);
      }
      expect(readCreatedTitle(merges[0])).toBe("File the left task and File the right task");
    });
  });

  it("runs after the branches that fired when a false condition cuts another branch off", async () => {
    await withSetUpController(async ({ base, token }) => {
      // `right` is never reached, and the edge from `middle` into `merge` is
      // false, so only the edge from `left` fires.
      const run = await runToEnd(base, token, {
        name: "A branch cut off",
        steps: [
          buildCreateStep("root"),
          buildCreateStep("left"),
          buildCreateStep("middle"),
          buildCreateStep("right"),
          {
            id: "merge",
            kind: "action",
            action: "task.create",
            join: "all",
            params: {
              title: "{{ has(steps.right) ? 'both' : steps.left.output.title }}",
              description: "",
            },
          },
        ],
        edges: [
          { from: "root", to: "left" },
          { from: "root", to: "middle" },
          { from: "root", to: "right", condition: "false" },
          { from: "left", to: "merge" },
          { from: "middle", to: "merge", condition: "false" },
          { from: "right", to: "merge" },
        ],
      });

      expect(run.status, JSON.stringify(run)).toBe("completed");
      expect(listRecordSummaries(run)).toEqual([
        ["left", 1, "completed"],
        ["merge", 1, "completed"],
        ["middle", 1, "completed"],
        ["root", 1, "completed"],
      ]);
      expect(readCreatedTitle(findStepRecords(run, "merge")[0])).toBe("File the left task");
    });
  });

  it("gets no record when no incoming edge fired, nor does a step only it leads to, and the run completes", async () => {
    await withSetUpController(async ({ base, token }) => {
      const run = await runToEnd(base, token, {
        name: "A join nothing reaches",
        steps: [
          buildCreateStep("root"),
          buildCreateStep("left"),
          buildCreateStep("right"),
          buildCreateStep("merge", { join: "all" }),
          buildCreateStep("after"),
        ],
        edges: [
          { from: "root", to: "left" },
          { from: "root", to: "right" },
          { from: "left", to: "merge", condition: "false" },
          { from: "right", to: "merge", condition: "false" },
          { from: "merge", to: "after" },
        ],
      });

      expect(run.status, JSON.stringify(run)).toBe("completed");
      expect(listRecordSummaries(run)).toEqual([
        ["left", 1, "completed"],
        ["right", 1, "completed"],
        ["root", 1, "completed"],
      ]);
    });
  });

  it("runs once, after the loop upstream of it has exited", async () => {
    await withSetUpController(async ({ base, token }) => {
      // `count` leads into `merge` on every round of the loop, and `side` is
      // a second entry step that leads into `merge` once.
      const run = await runToEnd(
        base,
        token,
        {
          name: "A loop before a join",
          inputs: [{ name: "target", schema: { type: "integer", minimum: 1 }, required: true }],
          steps: [
            {
              id: "file",
              kind: "action",
              action: "task.create",
              entry: true,
              params: { title: "A loop task", description: "", labels: ["loop"] },
            },
            { id: "count", kind: "action", action: "task.query", params: { labels: ["loop"] } },
            buildCreateStep("side"),
            {
              id: "merge",
              kind: "action",
              action: "task.create",
              join: "all",
              params: { title: `Merged after {{ ${COUNTED} }}`, description: "" },
            },
          ],
          edges: [
            { from: "file", to: "count" },
            {
              from: "count",
              to: "file",
              condition: `${COUNTED} < inputs.target`,
              maxTraversals: 5,
            },
            { from: "count", to: "merge" },
            { from: "side", to: "merge" },
          ],
        },
        { target: 3 },
      );

      expect(run.status, JSON.stringify(run)).toBe("completed");
      expect(listStatuses(run, "count")).toEqual(["completed", "completed", "completed"]);
      const merges = findStepRecords(run, "merge");
      expect(merges.map((record) => [record.iteration, record.status])).toEqual([[1, "completed"]]);
      expect(readCreatedTitle(merges[0])).toBe("Merged after 3");
      const lastCount = findStepRecords(run, "count").find((record) => record.iteration === 3);
      expect(
        expectStatus(merges[0], "completed").startedAt >=
          expectStatus(lastCount, "completed").finishedAt,
      ).toBe(true);
    });
  });
});

/* ------------------------------------------------------------------------ */
/* maxTraversals and iteration-limit.                                        */
/* ------------------------------------------------------------------------ */

describe("maxTraversals", () => {
  it("lets the run carry on when the edge's condition is false after its last allowed firing, and counts only firings", async () => {
    await withSetUpController(async ({ base, token }) => {
      // The loop edge fires twice, its limit. On the third round its
      // condition is false, so the run goes on to `done`.
      const run = await runToEnd(base, token, buildCountingLoop(2), { target: 3 });

      expect(run.status, JSON.stringify(run)).toBe("completed");
      expect(listStatuses(run, "file")).toEqual(["completed", "completed", "completed"]);
      expect(readCreatedTitle(findStepRecords(run, "done")[0])).toBe("Counted 3");
      expect(run.edgeTraversals).toEqual([3, 3, 2, 1]);
    });
  });

  it("fails the run with iteration-limit when the condition is true and the edge has no firing left, and cancels every active record", async () => {
    await withSetUpController(async ({ base, token }) => {
      const run = await runToEnd(base, token, buildCountingLoop(2), { target: 4 });

      const failed = expectStatus(run, "failed");
      expect(failed).toMatchObject({
        failureReason: "iteration-limit",
        failedStepId: "count",
        failedEdge: { index: 2 },
      });
      // The edge fired twice, so `file` ran once as the entry step and twice more.
      expect(listStatuses(run, "file")).toEqual(["completed", "completed", "completed"]);
      expect(listStatuses(run, "count")).toEqual(["completed", "completed", "completed"]);
      // The third `log` record was created by edge 1 in the transaction in
      // which edge 2 ran out.
      expect(listStatuses(run, "log")).toEqual(["completed", "completed", "cancelled"]);
      expect(findStepRecords(run, "done")).toEqual([]);
      expect(run.edgeTraversals[2]).toBe(2);
    });
  });

  it("returns one traversal count per plan edge, in plan order, zeros included", async () => {
    await withSetUpController(async ({ base, token }) => {
      const branching = await runToEnd(base, token, {
        name: "One edge not taken",
        steps: [buildCreateStep("first"), buildCreateStep("taken"), buildCreateStep("not_taken")],
        edges: [
          { from: "first", to: "not_taken", condition: "false" },
          { from: "first", to: "taken" },
        ],
      });
      expect(branching.status, JSON.stringify(branching)).toBe("completed");
      expect(branching.edgeTraversals).toEqual([0, 1]);

      const single = await runToEnd(base, token, {
        name: "No edges",
        steps: [buildCreateStep("only")],
      });
      expect(single.edgeTraversals).toEqual([]);
    });
  });
});
