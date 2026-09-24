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
    // `create` went to `label` and to `query`; `query` has not run yet.
    edgeTraversals: [1, 1, 0],
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
  /** An axis wide enough that only the most ticks an axis has limits the step. */
  const WIDE = 100;

  it("ends the axis at now, with round ticks inside it", () => {
    const timeline = buildTimeline(run, Date.parse(START) + 43, WIDE);
    assert.strictEqual(timeline.elapsedMs, 43);
    assert.deepStrictEqual(
      timeline.ticks.map((tick) => tick.label),
      ["0", "10ms", "20ms", "30ms", "40ms"],
    );
    assert.deepStrictEqual(
      timeline.ticks.map((tick) => tick.position),
      [0, 10 / 43, 20 / 43, 30 / 43, 40 / 43],
    );
  });

  it("gives a run that took no measurable time an axis of one millisecond", () => {
    const instant = buildTimeline(endRun(START), 0, WIDE);
    assert.strictEqual(instant.elapsedMs, 0);
    assert.deepStrictEqual(
      instant.ticks.map((tick) => tick.label),
      ["0", "1ms"],
    );
  });

  it("draws a bar from each record's start to its end, or to now while it runs", () => {
    const bars = buildTimeline(run, Date.parse(START) + 43, WIDE).lines.map((each) => each.bar);
    assert.deepStrictEqual(bars, [
      { start: 0, end: 10 / 43 },
      { start: 12 / 43, end: 1 },
      undefined,
      undefined,
    ]);
  });

  it("ends the axis where an ended run ended, and labels seconds and minutes", () => {
    const ended = buildTimeline(endRun(at(4_300)), Date.parse(START) + 99_000, WIDE);
    assert.strictEqual(ended.elapsedMs, 4_300);
    assert.deepStrictEqual(
      ended.ticks.map((tick) => tick.label),
      ["0", "1s", "2s", "3s", "4s"],
    );
    const long = buildTimeline(endRun(at(150_000)), 0, WIDE);
    assert.deepStrictEqual(
      long.ticks.map((tick) => tick.label),
      ["0", "30s", "1m", "1m 30s", "2m", "2m 30s"],
    );
  });

  it("centres each label on its tick unless that would reach past an end of the axis", () => {
    const timeline = buildTimeline(run, Date.parse(START) + 43, WIDE);
    assert.deepStrictEqual(
      timeline.ticks.map((tick) => tick.align),
      ["start", "center", "center", "center", "center"],
    );
    // "20s" at 20 of 20.04 seconds is 0.05 characters from the end of a
    // 24-character axis, so centring it would reach past the end.
    const nearEnd = buildTimeline(endRun(at(20_040)), 0, 24);
    assert.deepStrictEqual(
      nearEnd.ticks.map((tick) => tick.align),
      ["start", "center", "end"],
    );
  });

  it("spaces the ticks wider on a narrow axis, so the labels do not touch", () => {
    // A 20-second run on the axis of a 525px steps panel: 153px, or 24 characters
    // of 10.5px IBM Plex Mono. A tick every 5 seconds would put "15s" and the
    // "20s" that ends the axis one and a half characters apart.
    const narrow = buildTimeline(endRun(at(20_000)), 0, 24);
    assert.deepStrictEqual(
      narrow.ticks.map((tick) => [tick.label, tick.position]),
      [
        ["0", 0],
        ["10s", 0.5],
        ["20s", 1],
      ],
    );
    // On a wide axis the same run gets a tick every 5 seconds.
    assert.deepStrictEqual(
      buildTimeline(endRun(at(20_000)), 0, WIDE).ticks.map((tick) => tick.label),
      ["0", "5s", "10s", "15s", "20s"],
    );
  });

  it("keeps every label inside the axis and two characters from the next, at any width and length", () => {
    const shares = { start: 0, center: 0.5, end: 1 } as const;
    for (const elapsedMs of [
      7, 43, 950, 4_300, 20_000, 20_040, 23_000, 95_000, 150_000, 5_400_000, 90_000_000,
    ]) {
      for (let width = 0; width <= 120; width += 2) {
        const { ticks } = buildTimeline(endRun(at(elapsedMs)), 0, width);
        const context = `${String(elapsedMs)}ms at ${String(width)}`;
        assert.strictEqual(ticks[0]?.label, "0", context);
        for (const tick of ticks) {
          const length = [...tick.label].length;
          const left = tick.position * width - length * shares[tick.align];
          assert.isAtMost(tick.position, 1, `${tick.label} past the end, ${context}`);
          // The lone tick at 0 of an axis too narrow for any step may be wider than the axis.
          if (ticks.length === 1) continue;
          assert.isAtLeast(left, -1e-9, `${tick.label} before the start, ${context}`);
          assert.isAtMost(left + length, width + 1e-9, `${tick.label} after the end, ${context}`);
        }
        for (const [index, tick] of ticks.slice(1).entries()) {
          const previous = ticks[index]!;
          const space =
            (tick.position - previous.position) * width -
            [...previous.label].length * (1 - shares[previous.align]) -
            [...tick.label].length * shares[tick.align];
          // The tolerance absorbs floating-point rounding at an exact fit.
          assert.isAtLeast(space, 2 - 1e-9, `${previous.label} and ${tick.label}, ${context}`);
        }
      }
    }
  });

  it("ends a 23-second run's axis at 23 seconds, past its last tick", () => {
    const timeline = buildTimeline(endRun(at(23_000)), 0, 24);
    assert.deepStrictEqual(
      timeline.ticks.map((tick) => [tick.label, tick.position, tick.align]),
      [
        ["0", 0, "start"],
        ["10s", 10 / 23, "center"],
        ["20s", 20 / 23, "center"],
      ],
    );
  });

  it("never steps back to shorter ticks while a live run grows", () => {
    for (const width of [24, 60, 100]) {
      let previousStep = 0;
      for (let elapsedMs = 100; elapsedMs <= 600_000; elapsedMs += 100) {
        const { ticks } = buildTimeline(run, Date.parse(START) + elapsedMs, width);
        if (ticks.length < 2) continue;
        const step = ticks[1]!.position * elapsedMs;
        assert.isAtLeast(step, previousStep - 1e-6, `${String(elapsedMs)}ms at ${String(width)}`);
        previousStep = step;
      }
    }
  });

  it("gives an axis too narrow for any step only the tick at 0", () => {
    const cramped = buildTimeline(run, Date.parse(START) + 43, 0);
    assert.deepStrictEqual(
      cramped.ticks.map((tick) => tick.label),
      ["0"],
    );
  });

  it("steps a run of several days in whole days", () => {
    const days = buildTimeline(endRun(at(10 * 86_400_000)), 0, WIDE);
    assert.deepStrictEqual(
      days.ticks.map((tick) => tick.label),
      ["0", "48h", "96h", "144h", "192h", "240h"],
    );
  });
});
