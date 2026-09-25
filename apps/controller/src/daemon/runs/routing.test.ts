/**
 * Unit tests for routing: which edges a finished step follows, when a
 * `join: all` step is ready, when a step can never run, and when an edge has
 * been followed as often as it may. Each test builds a run as it would be
 * read inside the transaction that finished a step, and checks the decision.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import type { StepRecord, WorkflowDefinition } from "@hercule/contract";
import { buildRunContext, decideRouting, type RoutedRun } from "./routing";

const at = "2026-09-25T00:00:00.000Z";

/** A completed record of `stepId` at `iteration`, with `output`. */
const buildCompleted = (stepId: string, iteration = 1, output: unknown = {}): StepRecord => ({
  stepId,
  iteration,
  status: "completed",
  startedAt: at,
  finishedAt: at,
  output: output as never,
});

/** A pending record of `stepId` at `iteration`. */
const buildPending = (stepId: string, iteration = 1): StepRecord => ({
  stepId,
  iteration,
  status: "pending",
});

/** A plan of action steps, with `join: all` on the steps named in `joins`. */
const buildPlan = (
  stepIds: ReadonlyArray<string>,
  edges: NonNullable<WorkflowDefinition["edges"]>,
  joins: ReadonlyArray<string> = [],
): WorkflowDefinition => ({
  name: "Routing",
  steps: stepIds.map((id) => ({
    id,
    kind: "action",
    action: "task.create",
    ...(joins.includes(id) ? { join: "all" as const } : {}),
  })),
  edges,
});

/** Returns the decision after `finishedStepId` finished, for a run with these records and counts. */
const routeAfter = (
  plan: WorkflowDefinition,
  steps: ReadonlyArray<StepRecord>,
  edgeTraversals: ReadonlyArray<number>,
  finishedStepId: string,
) => {
  const run: RoutedRun = { plan, inputs: {}, steps, edgeTraversals };
  return Effect.runSync(decideRouting(run, finishedStepId));
};

describe("join: all and the settled rule", () => {
  /** A diamond: `root` leads to `left` and `right`, which both lead into `merge`. */
  const DIAMOND = buildPlan(
    ["root", "left", "right", "merge"],
    [
      { from: "root", to: "left" },
      { from: "root", to: "right" },
      { from: "left", to: "merge" },
      { from: "right", to: "merge" },
    ],
    ["merge"],
  );

  it("waits while a source still has an active record", () => {
    const decision = routeAfter(
      DIAMOND,
      [buildCompleted("root"), buildCompleted("left"), buildPending("right")],
      [1, 1, 0, 0],
      "left",
    );
    expect(decision).toEqual({
      traversedEdgeIndexes: [2],
      readyStepIds: [],
      ending: { _tag: "continues" },
    });
  });

  it("gets a record once every source is settled and one of its edges fired", () => {
    const decision = routeAfter(
      DIAMOND,
      [buildCompleted("root"), buildCompleted("left"), buildCompleted("right")],
      [1, 1, 1, 0],
      "right",
    );
    expect(decision).toEqual({
      traversedEdgeIndexes: [3],
      readyStepIds: ["merge"],
      ending: { _tag: "continues" },
    });
  });

  it("waits while an active record upstream of a source can still reach it, such as a loop", () => {
    // `file` and `count` loop; `count` and `side` lead into `merge`.
    const plan = buildPlan(
      ["file", "count", "side", "merge"],
      [
        { from: "file", to: "count" },
        { from: "count", to: "file", maxTraversals: 5 },
        { from: "count", to: "merge" },
        { from: "side", to: "merge" },
      ],
      ["merge"],
    );
    const decision = routeAfter(
      plan,
      [buildCompleted("file"), buildCompleted("side"), buildPending("count")],
      [1, 0, 0, 0],
      "side",
    );
    expect(decision.readyStepIds).toEqual([]);
    expect(decision.ending).toEqual({ _tag: "continues" });
  });

  it("makes a join that another ready join leads into wait for it", () => {
    // `first` and `second` both join; `first` leads into `second`, which
    // comes earlier in the plan. `z` has already fired into `second`.
    const plan = buildPlan(
      ["root", "x", "z", "second", "first"],
      [
        { from: "root", to: "x" },
        { from: "root", to: "z" },
        { from: "x", to: "first" },
        { from: "first", to: "second" },
        { from: "z", to: "second" },
      ],
      ["first", "second"],
    );
    const decision = routeAfter(
      plan,
      [buildCompleted("root"), buildCompleted("z"), buildCompleted("x")],
      [1, 1, 0, 0, 1],
      "x",
    );
    expect(decision.readyStepIds).toEqual(["first"]);
  });
});

describe("a step that can never run", () => {
  it("gets no record when every incoming edge settled without firing, nor does what only it leads to, and the run completes", () => {
    const plan = buildPlan(
      ["root", "left", "right", "merge", "after"],
      [
        { from: "root", to: "left" },
        { from: "root", to: "right" },
        { from: "left", to: "merge", condition: "false" },
        { from: "right", to: "merge", condition: "false" },
        { from: "merge", to: "after" },
      ],
      ["merge"],
    );
    const decision = routeAfter(
      plan,
      [buildCompleted("root"), buildCompleted("left"), buildCompleted("right")],
      [1, 1, 0, 0, 0],
      "right",
    );
    expect(decision).toEqual({
      traversedEdgeIndexes: [],
      readyStepIds: [],
      ending: { _tag: "completed" },
    });
  });
});

describe("maxTraversals", () => {
  /** `count` leads to `log` always, and back to `file` while `inputs.more` is true, at most twice. */
  const LOOP = buildPlan(
    ["file", "count", "log"],
    [
      { from: "file", to: "count" },
      { from: "count", to: "log" },
      { from: "count", to: "file", condition: "inputs.more", maxTraversals: 2 },
    ],
  );
  const RECORDS = [buildCompleted("file", 3), buildCompleted("count", 3)];

  const decideWithMore = (more: boolean, traversals: ReadonlyArray<number>) =>
    Effect.runSync(
      decideRouting(
        { plan: LOOP, inputs: { more }, steps: RECORDS, edgeTraversals: traversals },
        "count",
      ),
    );

  it("follows the edge while it has firings left", () => {
    expect(decideWithMore(true, [2, 1, 1])).toEqual({
      traversedEdgeIndexes: [1, 2],
      readyStepIds: ["log", "file"],
      ending: { _tag: "continues" },
    });
  });

  it("fails with iteration-limit when the condition is true and no firing is left, keeping what earlier edges did", () => {
    const decision = decideWithMore(true, [3, 2, 2]);
    expect(decision.traversedEdgeIndexes).toEqual([1]);
    expect(decision.readyStepIds).toEqual(["log"]);
    expect(decision.ending).toMatchObject({
      _tag: "failed",
      failureReason: "iteration-limit",
      failedEdgeIndex: 2,
    });
  });

  it("lets the run carry on when the condition is false after the last firing", () => {
    expect(decideWithMore(false, [3, 2, 2]).ending).toEqual({ _tag: "continues" });
  });
});

describe("an edge condition that cannot be decided", () => {
  it("fails with expression-error at the edge, keeping what earlier edges did", () => {
    const plan = buildPlan(
      ["start", "first", "second"],
      [
        { from: "start", to: "first" },
        { from: "start", to: "second", condition: "steps.never.output.id == 1" },
      ],
    );
    const decision = routeAfter(plan, [buildCompleted("start")], [0, 0], "start");
    expect(decision.traversedEdgeIndexes).toEqual([0]);
    expect(decision.readyStepIds).toEqual(["first"]);
    expect(decision.ending).toMatchObject({
      _tag: "failed",
      failureReason: "expression-error",
      failedEdgeIndex: 1,
    });
  });
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
        buildPending("count", 3),
      ],
    });
    expect(context).toEqual({ inputs: { target: 3 }, steps: { count: { output: { n: 2 } } } });
  });
});

describe("a terminal step", () => {
  /** `root` leads to `finish`, a terminal step, which leads to `after`; `side` runs beside it. */
  const PLAN = buildPlan(
    ["root", "finish", "after", "side"],
    [
      { from: "root", to: "finish" },
      { from: "finish", to: "after" },
    ],
  );
  const TERMINAL: WorkflowDefinition = {
    ...PLAN,
    steps: PLAN.steps.map((step) => (step.id === "finish" ? { ...step, terminal: true } : step)),
  };

  it("completes the run with its output when it completes, follows none of its edges, and ignores active records", () => {
    const decision = routeAfter(
      TERMINAL,
      [buildCompleted("root"), buildPending("side"), buildCompleted("finish", 1, { id: "t_1" })],
      [1, 0],
      "finish",
    );
    expect(decision).toEqual({
      traversedEdgeIndexes: [],
      readyStepIds: [],
      ending: { _tag: "completed", output: { id: "t_1" } },
    });
  });

  it("routes like any other step when it was skipped", () => {
    const decision = routeAfter(
      TERMINAL,
      [
        buildCompleted("root"),
        { stepId: "finish", iteration: 1, status: "skipped", finishedAt: at },
      ],
      [1, 0],
      "finish",
    );
    expect(decision).toEqual({
      traversedEdgeIndexes: [1],
      readyStepIds: ["after"],
      ending: { _tag: "continues" },
    });
  });
});
