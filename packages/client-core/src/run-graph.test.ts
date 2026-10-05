import { assert, describe, it } from "vitest";
import type { Run, StepRecord } from "@hercule/contract";
import { buildRunGraph, buildStepLines, buildTimeline, type Timeline } from "./run-graph";

const START = "2026-09-24T12:00:00.000Z";
const at = (ms: number): string => new Date(Date.parse(START) + ms).toISOString();

/** A fan-out: `create` leads to `label` and `query`, and `query` leads to `update`. */
const PLAN: Run["plan"] = {
  name: "Triage a new issue",
  triggers: [{ id: "weekdays", kind: "start", on: { schedule: "0 9 * * 1-5" } }],
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

/** The fields of a run that none of these tests read. */
const RUN_FIELDS = {
  id: "01a06d02-c111-7a0e-8b3d-9c1f1f3a9c2e",
  workflowId: null,
  inputs: {},
  origin: { kind: "manual", actor: "user" },
  subscriptions: [],
  createdAt: START,
} as const;

const RUNNING: Run = {
  ...RUN_FIELDS,
  plan: PLAN,
  status: "running",
  startedAt: START,
  steps: STEPS,
  // `create` went to `label` and to `query`; `query` has not run yet.
  edgeTraversals: [1, 1, 0],
};

/**
 * The demo workflow of the routing ticket. `lookup` finds nothing, so the
 * branch to `reuse` is not taken; `file` and `count` loop until the count
 * reaches the target, along an edge that may be followed 3 times; `escalate`
 * is skipped unless the run is urgent; `finish` ends the run.
 *
 * The edges by index: 0 lookup>reuse, 1 lookup>file, 2 file>count,
 * 3 count>file (the loop, max 3), 4 count>escalate, 5 escalate>settle,
 * 6 settle>finish.
 */
const DEMO_PLAN: Run["plan"] = {
  name: "File a batch",
  steps: [
    { id: "lookup", kind: "action", action: "task.query" },
    { id: "reuse", kind: "action", action: "task.update", terminal: true },
    { id: "file", kind: "action", action: "task.create" },
    { id: "count", kind: "action", action: "task.query" },
    { id: "escalate", kind: "action", action: "task.update", condition: "inputs.urgent" },
    { id: "settle", kind: "action", action: "wait" },
    { id: "finish", kind: "action", action: "task.update", terminal: true },
  ],
  edges: [
    { from: "lookup", to: "reuse", condition: "size(steps.lookup.output.items) > 0" },
    { from: "lookup", to: "file", condition: "size(steps.lookup.output.items) == 0" },
    { from: "file", to: "count" },
    {
      from: "count",
      to: "file",
      condition: "size(steps.count.output.items) < inputs.target",
      maxTraversals: 3,
    },
    { from: "count", to: "escalate", condition: "size(steps.count.output.items) >= inputs.target" },
    { from: "escalate", to: "settle" },
    { from: "settle", to: "finish" },
  ],
};

/** Returns a completed step record of `stepId`, which ran from `from` to `to` milliseconds. */
const complete = (stepId: string, iteration: number, from: number, to: number): StepRecord => ({
  stepId,
  iteration,
  status: "completed",
  startedAt: at(from),
  finishedAt: at(to),
  output: { items: [] },
});

/** The records of `lookup`, then `file` and `count` looping `times` times. */
const loopRecords = (times: number): ReadonlyArray<StepRecord> => [
  complete("lookup", 1, 0, 10),
  ...Array.from({ length: times }, (_, index) => [
    complete("file", index + 1, 100 * index + 20, 100 * index + 40),
    complete("count", index + 1, 100 * index + 50, 100 * index + 70),
  ]).flat(),
];

/** The demo run, completed: the loop ran 3 times, `escalate` was skipped, `finish` ended the run. */
const DEMO_COMPLETED: Run = {
  ...RUN_FIELDS,
  plan: DEMO_PLAN,
  status: "completed",
  startedAt: START,
  finishedAt: at(1_000),
  output: { id: "t_1", status: "in-progress" },
  steps: [
    ...loopRecords(3),
    { stepId: "escalate", iteration: 1, status: "skipped", finishedAt: at(400) },
    complete("settle", 1, 410, 900),
    complete("finish", 1, 910, 1_000),
  ],
  edgeTraversals: [0, 1, 3, 2, 1, 1, 1],
};

/**
 * The demo run with a target the loop cannot reach: `count` wanted to go back
 * to `file` a fourth time, and the run failed at the loop edge.
 */
const DEMO_ITERATION_LIMIT: Run = {
  ...RUN_FIELDS,
  plan: DEMO_PLAN,
  status: "failed",
  failureReason: "iteration-limit",
  failedStepId: "count",
  failedEdge: {
    index: 3,
    message:
      "The run was to follow the edge from count to file again, but it has already followed it 3 times, the most this edge allows.",
  },
  startedAt: START,
  finishedAt: at(500),
  steps: loopRecords(4),
  edgeTraversals: [0, 1, 4, 3, 0, 0, 0],
};

const IMPLEMENT_SESSION_ID = "01a06d02-c111-7a0e-8b3d-9c1f00005e55";

/**
 * A plan with an agent step and a signal trigger: `implement` drives an
 * Agent's session and `open_pr` opens a pull request. When the checks fail,
 * `checks_failed` sends the run back to `implement`, or on to `escalate`
 * once the checks have failed often enough; after the pull request is
 * opened, `notify` runs only when asked to.
 *
 * The edges by index: 0 implement>open_pr, 1 checks_failed>implement (max 3),
 * 2 checks_failed>escalate, 3 open_pr>notify.
 */
const SIGNAL_PLAN: Run["plan"] = {
  name: "Implement and open a pull request",
  triggers: [
    {
      id: "checks_failed",
      kind: "signal",
      on: { kind: "github.checks.failed", connectionId: "any" },
      correlation: { event: "event.payload.prNumber", run: "steps.open_pr.output.prNumber" },
    },
  ],
  steps: [
    {
      id: "implement",
      kind: "agent",
      agent: "01a06d02-c111-7a0e-8b3d-9c1f00000a01",
      prompt: "Implement the fix.",
    },
    { id: "open_pr", kind: "action", action: "github.pr.open" },
    { id: "escalate", kind: "action", action: "task.create" },
    { id: "notify", kind: "action", action: "task.update" },
  ],
  edges: [
    { from: "implement", to: "open_pr" },
    { from: "checks_failed", to: "implement", maxTraversals: 3 },
    {
      from: "checks_failed",
      to: "escalate",
      condition: "steps.checks_failed.output.count > 3",
    },
    { from: "open_pr", to: "notify", condition: "inputs.notify" },
  ],
};

/**
 * The signal run once the checks failed once: `implement` and `open_pr` ran
 * twice, and the run now waits for the checks to fail again. The session of
 * `implement` carried on across both of its records.
 */
const SIGNAL_WAITING: Run = {
  ...RUN_FIELDS,
  plan: SIGNAL_PLAN,
  status: "running",
  startedAt: START,
  steps: [
    { ...complete("implement", 1, 0, 100), sessionId: IMPLEMENT_SESSION_ID },
    complete("open_pr", 1, 110, 120),
    complete("checks_failed", 1, 300, 300),
    { ...complete("implement", 2, 310, 400), sessionId: IMPLEMENT_SESSION_ID },
    complete("open_pr", 2, 410, 420),
  ],
  edgeTraversals: [2, 1, 0, 0],
};

/** Returns a step's node of the graph of `run`. */
const findNode = (run: Run, stepId: string) =>
  buildRunGraph(run).nodes.find((node) => node.id === stepId);

/** Returns each edge of the graph of `run` as `from>to travel`. */
const listEdgeTravel = (run: Run): ReadonlyArray<string> =>
  buildRunGraph(run).edges.map((edge) => `${edge.from}>${edge.to} ${edge.travel}`);

describe("buildRunGraph", () => {
  it("gives each step its current state and times, and leaves the trigger without one", () => {
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

  it("shows a step's running record, else its pending record, else its latest record", () => {
    const run: Run = {
      ...RUNNING,
      steps: [
        // `create` is busy: its second record waits behind the running first one.
        { stepId: "create", iteration: 1, status: "running", startedAt: at(0) },
        { stepId: "create", iteration: 2, status: "pending" },
        // `label` has finished once and waits to run again.
        complete("label", 1, 0, 10),
        { stepId: "label", iteration: 2, status: "pending" },
        // `query` ran, then its condition was false the second time.
        complete("query", 1, 0, 10),
        { stepId: "query", iteration: 2, status: "skipped", finishedAt: at(20) },
      ],
    };
    const nodes = new Map(buildRunGraph(run).nodes.map((node) => [node.id, node]));
    assert.deepStrictEqual(nodes.get("create")?.progress, { state: "running", startedAt: at(0) });
    assert.deepStrictEqual(nodes.get("label")?.progress, { state: "pending" });
    assert.deepStrictEqual(nodes.get("query")?.progress, {
      state: "skipped",
      finishedAt: at(20),
    });
  });

  it("reads a step's running record when an earlier one failed", () => {
    const graph = buildRunGraph({
      ...RUNNING,
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

  it("counts each step's records, so a step that ran several times shows how often", () => {
    assert.deepStrictEqual(
      ["lookup", "reuse", "file", "count", "escalate", "settle", "finish"].map(
        (stepId) => findNode(DEMO_COMPLETED, stepId)?.iterationCount,
      ),
      [1, 0, 3, 3, 1, 1, 1],
    );
    // Only a step the run came to more than once carries a label for its card.
    assert.deepStrictEqual(
      ["lookup", "reuse", "file"].map((stepId) => findNode(DEMO_COMPLETED, stepId)?.iterationLabel),
      [undefined, undefined, "×3"],
    );
  });

  it("marks the terminal steps, which end the run when they complete", () => {
    assert.deepStrictEqual(
      ["lookup", "reuse", "file", "finish"].map((stepId) =>
        Boolean(findNode(DEMO_COMPLETED, stepId)?.terminal),
      ),
      [false, true, false, true],
    );
  });

  it("marks the edges the run went along, the one into the running step as active", () => {
    assert.deepStrictEqual(listEdgeTravel(RUNNING), [
      // A trigger does not fire for a run started by hand.
      "weekdays>create notYet",
      "create>label active",
      "create>query fired",
      // `query` has not finished, so its edge has not been decided.
      "query>update notYet",
    ]);
  });

  it("marks the edge from the start trigger that started the run as travelled, and no other trigger's", () => {
    const plan: Run["plan"] = {
      ...PLAN,
      triggers: [
        { id: "weekdays", kind: "start", on: { schedule: "0 9 * * 1-5" } },
        { id: "on_issue", kind: "start", on: { kind: "github.issue.opened" } },
      ],
    };
    const origin = { kind: "trigger", triggerId: "on_issue", eventId: 42 } as const;
    const creating: Run = {
      ...RUNNING,
      plan,
      origin,
      steps: [{ stepId: "create", iteration: 1, status: "running", startedAt: at(0) }],
      edgeTraversals: [0, 0, 0],
    };
    assert.deepStrictEqual(listEdgeTravel(creating).slice(0, 2), [
      "weekdays>create notYet",
      // The entry step the trigger led to is running, so the edge into it flows.
      "on_issue>create active",
    ]);
    const completed: Run = {
      ...RUN_FIELDS,
      plan,
      origin,
      status: "completed",
      startedAt: START,
      finishedAt: at(40),
      steps: [
        {
          stepId: "create",
          iteration: 1,
          status: "completed",
          startedAt: at(0),
          finishedAt: at(10),
          output: null,
        },
      ],
      edgeTraversals: [0, 0, 0],
    };
    assert.deepStrictEqual(listEdgeTravel(completed).slice(0, 2), [
      "weekdays>create notTaken",
      "on_issue>create fired",
    ]);
  });

  it("draws the edges of a finished run from how often the run followed each one", () => {
    assert.deepStrictEqual(listEdgeTravel(DEMO_COMPLETED), [
      // `lookup` finished and did not follow this edge: its condition was false.
      "lookup>reuse notTaken",
      "lookup>file fired",
      "file>count fired",
      "count>file fired",
      "count>escalate fired",
      // A skipped step passes the run on along its edges.
      "escalate>settle fired",
      "settle>finish fired",
    ]);
  });

  it("makes every followed edge into a running step active, and tells a decided edge from one not yet decided", () => {
    // The loop's second round: `file` runs again, after `lookup` and `count` sent the run to it.
    const midLoop: Run = {
      ...DEMO_COMPLETED,
      status: "running",
      steps: [
        ...loopRecords(1),
        { stepId: "file", iteration: 2, status: "running", startedAt: at(120) },
      ],
      edgeTraversals: [0, 1, 1, 1, 0, 0, 0],
    };
    assert.deepStrictEqual(listEdgeTravel(midLoop), [
      "lookup>reuse notTaken",
      "lookup>file active",
      "file>count fired",
      "count>file active",
      // `file` runs again and leads back to `count`, so `count` can still go on to `escalate`.
      "count>escalate notYet",
      "escalate>settle notYet",
      "settle>finish notYet",
    ]);

    // While the step waits to start, the edges into it are followed but not active.
    const queued: Run = {
      ...midLoop,
      steps: [...loopRecords(1), { stepId: "file", iteration: 2, status: "pending" }],
    };
    assert.deepStrictEqual(listEdgeTravel(queued).slice(0, 4), [
      "lookup>reuse notTaken",
      "lookup>file fired",
      "file>count fired",
      "count>file fired",
    ]);
  });

  it("draws an edge the run did not follow as not taken once the run has ended", () => {
    // The run failed in the loop: `count` can no longer run again, and no
    // step after it ever will.
    assert.deepStrictEqual(listEdgeTravel(DEMO_ITERATION_LIMIT), [
      "lookup>reuse notTaken",
      "lookup>file fired",
      "file>count fired",
      "count>file fired",
      "count>escalate notTaken",
      "escalate>settle notTaken",
      "settle>finish notTaken",
    ]);
  });

  it("counts a capped edge's traversals against its limit, and no other edge's", () => {
    const badges = buildRunGraph(DEMO_COMPLETED).edges.map((edge) => edge.traversalBadge);
    assert.deepStrictEqual(badges, [
      undefined,
      undefined,
      undefined,
      "2/3",
      undefined,
      undefined,
      undefined,
    ]);
    assert.isTrue(buildRunGraph(DEMO_COMPLETED).edges.every((edge) => !edge.isFailedEdge));
  });

  it("marks the capped edge that failed the run with iteration-limit", () => {
    const edges = buildRunGraph(DEMO_ITERATION_LIMIT).edges;
    assert.strictEqual(edges[3]?.traversalBadge, "3/3");
    assert.deepStrictEqual(
      edges.map((edge) => edge.isFailedEdge),
      [false, false, false, true, false, false, false],
    );
    assert.deepStrictEqual(
      edges.map((edge) => edge.isOverLimit),
      [false, false, false, true, false, false, false],
    );
  });

  it("marks the edge whose condition failed the run with expression-error", () => {
    const failed: Run = {
      ...DEMO_ITERATION_LIMIT,
      failureReason: "expression-error",
      failedEdge: {
        index: 4,
        message:
          "The condition of the edge from count to escalate could not be evaluated: no such key",
      },
      steps: loopRecords(1),
      edgeTraversals: [0, 1, 1, 0, 0, 0, 0],
    };
    const edges = buildRunGraph(failed).edges;
    assert.deepStrictEqual(
      edges.map((edge) => edge.isFailedEdge),
      [false, false, false, false, true, false, false],
    );
    // The edge has no limit, so no count shows on it, and the run did not fail on a limit.
    assert.strictEqual(edges[4]?.traversalBadge, undefined);
    assert.isTrue(edges.every((edge) => !edge.isOverLimit));
  });

  it("marks no edge of a run that failed at a step", () => {
    const failed: Run = {
      ...RUNNING,
      status: "failed",
      failureReason: "step-failed",
      failedStepId: "label",
      finishedAt: at(20),
      steps: [
        STEPS[0]!,
        {
          stepId: "label",
          iteration: 1,
          status: "failed",
          startedAt: at(12),
          finishedAt: at(20),
          error: { code: "not_found", message: "no such task" },
        },
      ],
    };
    assert.isTrue(buildRunGraph(failed).edges.every((edge) => !edge.isFailedEdge));
  });

  it("keeps the edges a signal can still lead to open while the run is live, even after it fired", () => {
    assert.deepStrictEqual(listEdgeTravel(SIGNAL_WAITING), [
      "implement>open_pr fired",
      "checks_failed>implement fired",
      // The signal fired, but it can fire again with a higher count.
      "checks_failed>escalate notYet",
      // `open_pr` finished, but the signal can send the run through it again.
      "open_pr>notify notYet",
    ]);
    const cancelled: Run = {
      ...SIGNAL_WAITING,
      status: "cancelled",
      finishedAt: at(500),
    };
    assert.deepStrictEqual(listEdgeTravel(cancelled).slice(2), [
      "checks_failed>escalate notTaken",
      "open_pr>notify notTaken",
    ]);
  });

  it("counts how often a signal fired on its card, and gives it no state", () => {
    const fired = (count: number): Run => ({
      ...SIGNAL_WAITING,
      steps: Array.from({ length: count }, (_, index) =>
        complete("checks_failed", index + 1, index, index),
      ),
    });
    assert.deepStrictEqual(
      [1, 2].map((count) => {
        const node = findNode(fired(count), "checks_failed");
        return [node?.progress, node?.iterationCount, node?.iterationLabel];
      }),
      [
        [undefined, 1, undefined],
        [undefined, 2, "×2"],
      ],
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

  it("numbers every line of a step that has more than one record, and no line of any other step", () => {
    const labels = buildStepLines(DEMO_COMPLETED).map((line) => [line.stepId, line.iterationLabel]);
    assert.deepStrictEqual(labels, [
      ["lookup", undefined],
      ["file", "#1"],
      ["count", "#1"],
      ["file", "#2"],
      ["count", "#2"],
      ["file", "#3"],
      ["count", "#3"],
      ["escalate", undefined],
      ["settle", undefined],
      ["finish", undefined],
      // `reuse` was never reached.
      ["reuse", undefined],
    ]);
  });

  it("tells action steps, agent steps and signals apart, and carries an agent step's session", () => {
    const lines = buildStepLines(SIGNAL_WAITING);
    assert.deepStrictEqual(
      lines.map((line) => [line.key, line.kind, line.action, line.session]),
      [
        // Only the newest record that drives the session is marked as newest.
        ["implement#1", "agent", undefined, { id: IMPLEMENT_SESSION_ID, isNewestRecord: false }],
        ["open_pr#1", "action", "github.pr.open", undefined],
        ["checks_failed#1", "signal", undefined, undefined],
        ["implement#2", "agent", undefined, { id: IMPLEMENT_SESSION_ID, isNewestRecord: true }],
        ["open_pr#2", "action", "github.pr.open", undefined],
        // The steps the run has not reached. A signal that has not fired has no line.
        ["escalate", "action", "task.create", undefined],
        ["notify", "action", "task.update", undefined],
      ],
    );
  });

  it("gives a signal's line the output the signal delivered, to open like a step's", () => {
    const delivered = { prNumber: 42, failed: ["lint"] };
    const [line] = buildStepLines({
      plan: SIGNAL_PLAN,
      steps: [
        {
          stepId: "checks_failed",
          iteration: 1,
          status: "completed",
          startedAt: at(300),
          finishedAt: at(300),
          output: delivered,
        },
      ],
    });
    assert.deepStrictEqual(
      [line?.kind, line?.state, line?.output],
      ["signal", "completed", delivered],
    );
  });

  it("shows a skipped step as skipped, finished but never started, with no output", () => {
    const skipped = buildStepLines(DEMO_COMPLETED).find((line) => line.stepId === "escalate");
    assert.deepStrictEqual(
      [skipped?.state, skipped?.startedAt, skipped?.finishedAt, skipped?.output, skipped?.error],
      ["skipped", undefined, at(400), undefined, undefined],
    );
  });
});

describe("buildTimeline", () => {
  const FIELDS = {
    id: "01a06d02-c111-7a0e-8b3d-9c1f1f3a9c2e",
    workflowId: null,
    plan: PLAN,
    inputs: {},
    origin: { kind: "manual", actor: "user" },
    subscriptions: [],
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

  it("spaces the ticks wider on a narrow axis, so the labels do not touch", () => {
    // A 20-second run on an axis 100px wide: 16 characters of 10.5px IBM
    // Plex Mono. A tick every 5 seconds would put the centred labels "15s"
    // and "20s" one character apart.
    const narrow = buildTimeline(endRun(at(20_000)), 0, 16);
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

  it("keeps every centred label two characters from the next, at any width and length", () => {
    for (const elapsedMs of [
      7, 43, 950, 4_300, 20_000, 20_040, 23_000, 95_000, 150_000, 5_400_000, 90_000_000,
    ]) {
      for (let width = 0; width <= 120; width += 2) {
        const { ticks } = buildTimeline(endRun(at(elapsedMs)), 0, width);
        const context = `${String(elapsedMs)}ms at ${String(width)}`;
        assert.strictEqual(ticks[0]?.label, "0", context);
        for (const tick of ticks) {
          assert.isAtMost(tick.position, 1, `${tick.label} past the end, ${context}`);
        }
        for (const [index, tick] of ticks.slice(1).entries()) {
          const previous = ticks[index]!;
          const space =
            (tick.position - previous.position) * width -
            [...previous.label].length / 2 -
            [...tick.label].length / 2;
          // The tolerance absorbs floating-point rounding at an exact fit.
          assert.isAtLeast(space, 2 - 1e-9, `${previous.label} and ${tick.label}, ${context}`);
        }
      }
    }
  });

  it("ends a 23-second run's axis at 23 seconds, past its last tick", () => {
    const timeline = buildTimeline(endRun(at(23_000)), 0, 16);
    assert.deepStrictEqual(
      timeline.ticks.map((tick) => [tick.label, tick.position]),
      [
        ["0", 0],
        ["10s", 10 / 23],
        ["20s", 20 / 23],
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

  it("gives a line a bar or a note, and says nothing of a step a live run may still reach", () => {
    const readNotes = (timeline: Timeline) =>
      timeline.lines.map((each) => [each.line.stepId, each.bar !== undefined, each.note?.text]);
    // `query` waits to start; `update` may still be reached.
    assert.deepStrictEqual(readNotes(buildTimeline(run, Date.parse(START) + 43, WIDE)), [
      ["create", true, undefined],
      ["label", true, undefined],
      ["query", false, "pending"],
      ["update", false, undefined],
    ]);
    // The cancel stopped `label` while it ran, and reached `query` before it started.
    const cancelled: Run = {
      ...FIELDS,
      status: "cancelled",
      startedAt: START,
      finishedAt: at(40),
      steps: [
        STEPS[0]!,
        {
          stepId: "label",
          iteration: 1,
          status: "cancelled",
          startedAt: at(12),
          finishedAt: at(40),
        },
        { stepId: "query", iteration: 1, status: "cancelled", finishedAt: at(40) },
      ],
    };
    assert.deepStrictEqual(readNotes(buildTimeline(cancelled, 0, WIDE)), [
      ["create", true, undefined],
      ["label", true, undefined],
      ["query", false, "cancelled before it started"],
      ["update", false, "not reached"],
    ]);
  });

  it("notes a skipped record where it was skipped, and a step never reached at the end of the axis", () => {
    const timeline = buildTimeline(DEMO_COMPLETED, 0, WIDE);
    const notes = timeline.lines.map((each) => [each.line.stepId, each.note]);
    assert.deepStrictEqual(
      notes.filter(([, note]) => note !== undefined),
      [
        ["escalate", { text: "skipped", position: 0.4 }],
        ["reuse", { text: "not reached", position: 1 }],
      ],
    );
  });
});
