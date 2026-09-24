import { assert, describe, it } from "vitest";
import type { Run, StepRecord } from "@hercule/contract";
import { buildRunGraph, buildStepLines, buildTimeline } from "./run-graph";

const START = "2026-09-24T12:00:00.000Z";
const at = (ms: number): string => new Date(Date.parse(START) + ms).toISOString();

/** A fan-out: `create` leads to `label` and `query`, and `query` leads to `update`. */
const PLAN: Run["plan"] = {
  name: "Triage a new issue",
  triggers: [{ id: "weekdays", kind: "start", source: { kind: "cron.tick" } }],
  steps: [
    { id: "create", kind: "action", action: "task.create" },
    { id: "label", kind: "action", action: "task.update" },
    { id: "query", kind: "action", action: "task.query" },
    { id: "update", kind: "action", action: "task.update" },
  ],
  edges: [
    { from: "create", to: "label" },
    { from: "create", to: "query" },
    { from: "query", to: "update" },
  ],
};

const STEPS: ReadonlyArray<StepRecord> = [
  {
    stepId: "create",
    iteration: 1,
    status: "completed",
    startedAt: at(0),
    finishedAt: at(10),
    output: { id: "t_1" },
  },
  { stepId: "label", iteration: 1, status: "running", startedAt: at(12) },
  { stepId: "query", iteration: 1, status: "pending" },
];

const RUNNING: Pick<Run, "plan" | "steps" | "status"> = {
  plan: PLAN,
  status: "running",
  steps: STEPS,
};

describe("buildRunGraph", () => {
  it("gives each step its latest state and times, and leaves the trigger without one", () => {
    const nodes = new Map(buildRunGraph(RUNNING).nodes.map((node) => [node.id, node]));
    assert.strictEqual(nodes.get("weekdays")?.progress, undefined);
    assert.strictEqual(buildRunGraph(RUNNING).status, "running");
    assert.deepStrictEqual(nodes.get("create")?.progress, {
      state: "completed",
      startedAt: at(0),
      finishedAt: at(10),
    });
    assert.deepStrictEqual(nodes.get("label")?.progress, { state: "running", startedAt: at(12) });
    assert.deepStrictEqual(nodes.get("query")?.progress, { state: "pending" });
    assert.deepStrictEqual(nodes.get("update")?.progress, { state: "unreached" });
  });

  it("marks the edges the run went along, the one into the running step as active", () => {
    const travel = buildRunGraph(RUNNING).edges.map(
      (edge) => `${edge.from}>${edge.to} ${edge.travel ?? ""}`,
    );
    assert.deepStrictEqual(travel, [
      "weekdays>create untravelled",
      "create>label active",
      "create>query travelled",
      "query>update untravelled",
    ]);
  });

  it("reads a step's latest record when it has several", () => {
    const graph = buildRunGraph({
      plan: PLAN,
      status: "running",
      steps: [
        {
          stepId: "create",
          iteration: 1,
          status: "failed",
          startedAt: at(0),
          finishedAt: at(10),
          error: { code: "unexpected", message: "The action failed." },
        },
        { stepId: "create", iteration: 2, status: "running", startedAt: at(12) },
      ],
    });
    assert.strictEqual(
      graph.nodes.find((node) => node.id === "create")?.progress?.state,
      "running",
    );
  });
});

describe("buildStepLines", () => {
  it("lists the step records in order, then the steps the run has not reached", () => {
    const lines = buildStepLines(RUNNING);
    assert.deepStrictEqual(
      lines.map((line) => [line.stepId, line.action, line.state]),
      [
        ["create", "task.create", "completed"],
        ["label", "task.update", "running"],
        ["query", "task.query", "pending"],
        ["update", "task.update", "unreached"],
      ],
    );
    assert.strictEqual(new Set(lines.map((line) => line.key)).size, lines.length);
  });

  it("carries a completed step's output, a failed step's error, and each step's times", () => {
    const error = { code: "not_found", message: "no such task" };
    const [created, labelled] = buildStepLines({
      plan: PLAN,
      steps: [
        STEPS[0]!,
        {
          stepId: "label",
          iteration: 1,
          status: "failed",
          startedAt: at(12),
          finishedAt: at(20),
          error,
        },
      ],
    });
    assert.deepStrictEqual(
      [created?.output, created?.error, created?.startedAt, created?.finishedAt],
      [{ id: "t_1" }, undefined, at(0), at(10)],
    );
    assert.deepStrictEqual([labelled?.output, labelled?.error], [undefined, error]);
  });
});

describe("buildTimeline", () => {
  const FIELDS = {
    id: "01a06d02-c111-7a0e-8b3d-9c1f1f3a9c2e",
    workflowId: null,
    plan: PLAN,
    inputs: {},
    origin: { kind: "manual", actor: "user" },
    steps: STEPS,
    createdAt: START,
  } as const;
  const run: Run = { ...FIELDS, status: "running", startedAt: START };
  /** Returns the run, completed at `finishedAt`. */
  const endRun = (finishedAt: string): Run => ({
    ...FIELDS,
    status: "completed",
    startedAt: START,
    finishedAt,
  });

  it("rounds the axis up to whole round ticks and places now on it", () => {
    const timeline = buildTimeline(run, Date.parse(START) + 43);
    assert.strictEqual(timeline.spanMs, 50);
    assert.deepStrictEqual(
      timeline.ticks.map((tick) => tick.label),
      ["0", "10ms", "20ms", "30ms", "40ms", "50ms"],
    );
    assert.strictEqual(timeline.now, 43 / 50);
    assert.strictEqual(timeline.elapsedMs, 43);
    assert.deepStrictEqual(
      timeline.ticks.map((tick) => tick.position),
      [0, 0.2, 0.4, 0.6, 0.8, 1],
    );
  });

  it("gives a run that took no measurable time an axis of one tick", () => {
    const instant = buildTimeline(endRun(START), 0);
    assert.strictEqual(instant.spanMs, 1);
    assert.strictEqual(instant.elapsedMs, 0);
    assert.strictEqual(instant.now, 0);
  });

  it("draws a bar from each record's start to its end, or to now while it runs", () => {
    const bars = buildTimeline(run, Date.parse(START) + 43).lines.map((each) => each.bar);
    assert.deepStrictEqual(bars, [
      { start: 0, end: 10 / 50 },
      { start: 12 / 50, end: 43 / 50 },
      undefined,
      undefined,
    ]);
  });

  it("ends the axis where an ended run ended, and labels seconds and minutes", () => {
    const ended = buildTimeline(endRun(at(4_300)), Date.parse(START) + 99_000);
    assert.strictEqual(ended.spanMs, 5_000);
    assert.strictEqual(ended.now, 4_300 / 5_000);
    assert.strictEqual(ended.elapsedMs, 4_300);
    assert.strictEqual(ended.ticks.at(-1)?.label, "5s");
    const long = buildTimeline(endRun(at(150_000)), 0);
    assert.deepStrictEqual(
      long.ticks.map((tick) => tick.label),
      ["0", "30s", "1m", "1m 30s", "2m", "2m 30s"],
    );
  });
});
