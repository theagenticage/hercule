import { assert, describe, it } from "vitest";
import type { Run, StepRecord } from "@hercule/contract";
import { buildRunGraph, buildStepRows, buildTimeline } from "./run-graph";

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

const record = (stepId: string, status: StepRecord["status"], times: object = {}): StepRecord => ({
  stepId,
  iteration: 1,
  status,
  ...times,
});

const RUNNING: Pick<Run, "plan" | "steps" | "status"> = {
  plan: PLAN,
  status: "running",
  steps: [
    record("create", "completed", { startedAt: at(0), finishedAt: at(10) }),
    record("label", "running", { startedAt: at(12) }),
    record("query", "pending"),
  ],
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
      steps: [record("create", "failed"), { ...record("create", "running"), iteration: 2 }],
    });
    assert.strictEqual(
      graph.nodes.find((node) => node.id === "create")?.progress?.state,
      "running",
    );
  });
});

describe("buildStepRows", () => {
  it("lists the step records in order, then the steps the run has not reached", () => {
    const rows = buildStepRows(RUNNING);
    assert.deepStrictEqual(
      rows.map((row) => [row.stepId, row.action, row.state]),
      [
        ["create", "task.create", "completed"],
        ["label", "task.update", "running"],
        ["query", "task.query", "pending"],
        ["update", "task.update", "unreached"],
      ],
    );
    assert.strictEqual(new Set(rows.map((row) => row.key)).size, rows.length);
  });
});

describe("buildTimeline", () => {
  const run: Parameters<typeof buildTimeline>[0] = {
    ...RUNNING,
    createdAt: START,
    startedAt: START,
  };

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
    const instant = buildTimeline({ ...run, finishedAt: START }, 0);
    assert.strictEqual(instant.spanMs, 1);
    assert.strictEqual(instant.elapsedMs, 0);
    assert.strictEqual(instant.now, 0);
  });

  it("draws a bar from each record's start to its end, or to now while it runs", () => {
    const bars = buildTimeline(run, Date.parse(START) + 43).rows.map((each) => each.bar);
    assert.deepStrictEqual(bars, [
      { start: 0, end: 10 / 50 },
      { start: 12 / 50, end: 43 / 50 },
      undefined,
      undefined,
    ]);
  });

  it("ends the axis where an ended run ended, and labels seconds and minutes", () => {
    const ended = buildTimeline({ ...run, finishedAt: at(4_300) }, Date.parse(START) + 99_000);
    assert.strictEqual(ended.spanMs, 5_000);
    assert.strictEqual(ended.now, 4_300 / 5_000);
    assert.strictEqual(ended.elapsedMs, 4_300);
    assert.strictEqual(ended.ticks.at(-1)?.label, "5s");
    const long = buildTimeline({ ...run, finishedAt: at(150_000) }, 0);
    assert.deepStrictEqual(
      long.ticks.map((tick) => tick.label),
      ["0", "30s", "1m", "1m 30s", "2m", "2m 30s"],
    );
  });
});
