import { assert, describe, it } from "vitest";
import type { OpenRequest, Run, StepRecord, WorkflowDefinition } from "@hercule/contract";
import {
  buildGraphDrawing,
  buildRunOverlay,
  decideStepRunState,
  type EdgeOnRun,
  type GraphEdge,
  type RunOverlay,
} from "./graph-model";
import { buildSession } from "./threads/workspaces.testing";

const AGENTS = [
  { id: "a-writer", name: "Writer" },
  { id: "a-reviewer", name: "Reviewer" },
];

const ACTIONS = [{ id: "github/pr.create", displayName: "Open a GitHub pull request" }];

/**
 * A small release: an issue label or the Friday schedule starts `notes` and
 * `review`; `review` and `fix` loop up to three times; `open_pr` waits for
 * both branches; the `merged` signal, correlated on the pull request's
 * number, leads to `announce`, which ends the run.
 */
const RELEASE: WorkflowDefinition = {
  name: "Release",
  triggers: [
    { id: "labeled", kind: "start", on: { kind: "github.issue.labeled" } },
    { id: "friday", kind: "start", on: { schedule: "0 14 * * 5" } },
    {
      id: "merged",
      kind: "signal",
      on: { kind: "github.pr.merged" },
      correlation: { event: "event.payload.number", run: "steps.open_pr.output.number" },
    },
  ],
  steps: [
    { id: "notes", kind: "agent", agent: "a-writer", prompt: "Write the notes." },
    { id: "review", kind: "agent", agent: "a-reviewer", prompt: "Review.", entry: true },
    { id: "fix", kind: "agent", agent: "a-coder", prompt: "Fix what the review found." },
    { id: "open_pr", kind: "action", action: "github/pr.create", join: "all" },
    { id: "announce", kind: "agent", agent: "a-writer", prompt: "Announce.", terminal: true },
  ],
  edges: [
    { from: "notes", to: "open_pr" },
    { from: "review", to: "open_pr", condition: 'steps.review.output.verdict == "approved"' },
    { from: "review", to: "fix", condition: 'steps.review.output.verdict == "changes"' },
    { from: "fix", to: "review", maxTraversals: 3 },
    { from: "merged", to: "announce" },
  ],
};

/** Returns the edge from `from` to `to`, failing the test when there is none. */
const findEdge = (edges: ReadonlyArray<GraphEdge>, from: string, to: string): GraphEdge => {
  const edge = edges.find((each) => each.from === from && each.to === to);
  assert.isDefined(edge, `no edge from ${from} to ${to}`);
  return edge;
};

describe("buildGraphDrawing", () => {
  it("names each card's step or trigger, and what it runs or fires on", () => {
    const { nodes } = buildGraphDrawing(RELEASE, AGENTS, ACTIONS);
    assert.deepStrictEqual(Object.fromEntries(nodes.map((node) => [node.id, node.detail])), {
      labeled: "github.issue.labeled",
      friday: "Fridays at 14:00",
      merged: "github.pr.merged",
      notes: "Writer",
      review: "Reviewer",
      // No Agent has the id, so the card shows the id.
      fix: "a-coder",
      open_pr: "Open a GitHub pull request",
      announce: "Writer",
    });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    assert.deepStrictEqual(
      nodes.map((node) => [node.id, node.firesOn]),
      [
        ["labeled", "event"],
        ["friday", "schedule"],
        ["merged", "event"],
        ["notes", null],
        ["review", null],
        ["fix", null],
        ["open_pr", null],
        ["announce", null],
      ],
    );
    assert.isTrue(byId.get("open_pr")?.joinsAll);
    assert.isTrue(byId.get("announce")?.terminal);
  });

  it("names the plugin of a plugin's action step, and none for a built-in action", () => {
    const definition: WorkflowDefinition = {
      name: "Track",
      steps: [
        { id: "open_pr", kind: "action", action: "github/pr.create" },
        { id: "file", kind: "action", action: "task.create" },
        { id: "notes", kind: "agent", agent: "a-writer", prompt: "Write the notes." },
      ],
      edges: [
        { from: "open_pr", to: "file" },
        { from: "file", to: "notes" },
      ],
    };
    const { nodes } = buildGraphDrawing(definition, AGENTS, ACTIONS);
    assert.deepStrictEqual(
      nodes.map((node) => [node.id, node.pluginId]),
      [
        ["open_pr", "github"],
        ["file", null],
        ["notes", null],
      ],
    );
  });

  it("fans two start triggers out to two entry steps through one junction", () => {
    const { edges, busId } = buildGraphDrawing(RELEASE, AGENTS, ACTIONS);
    assert.isDefined(busId);
    assert.deepStrictEqual(
      edges.filter((edge) => edge.to === busId).map((edge) => edge.from),
      ["labeled", "friday"],
    );
    assert.deepStrictEqual(
      edges.filter((edge) => edge.from === busId).map((edge) => edge.to),
      ["notes", "review"],
    );
    assert.isFalse(edges.some((edge) => edge.from === "labeled" && edge.to === "notes"));
  });

  it("connects a one-trigger workflow's trigger to its entry step directly", () => {
    const definition: WorkflowDefinition = {
      name: "Assign",
      triggers: [{ id: "opened", kind: "start", on: { kind: "github.pr.opened" } }],
      steps: [{ id: "pick", kind: "agent", agent: "a-reviewer", prompt: "Pick a reviewer." }],
    };
    const drawing = buildGraphDrawing(definition, AGENTS, ACTIONS);
    assert.isUndefined(drawing.busId);
    findEdge(drawing.edges, "opened", "pick");
  });

  it("labels conditions without their source step's prefix, and a loop with its limit", () => {
    const { edges } = buildGraphDrawing(RELEASE, AGENTS, ACTIONS);
    assert.deepInclude(findEdge(edges, "review", "open_pr"), {
      condition: 'verdict == "approved"',
      fullCondition: 'steps.review.output.verdict == "approved"',
      limit: undefined,
    });
    assert.deepInclude(findEdge(edges, "fix", "review"), { limit: "≤ 3", maxTraversals: 3 });
  });

  it("gives each edge of the definition the id of its index there", () => {
    const { edges } = buildGraphDrawing(RELEASE, AGENTS, ACTIONS);
    assert.strictEqual(findEdge(edges, "fix", "review").id, "plan 3");
    assert.strictEqual(new Set(edges.map((edge) => edge.id)).size, edges.length);
  });

  it("draws the step a signal correlates on as a dashed edge to the signal", () => {
    const edge = findEdge(buildGraphDrawing(RELEASE, AGENTS, ACTIONS).edges, "open_pr", "merged");
    assert.deepInclude(edge, {
      kind: "correlation",
      condition: "number",
      fullCondition: "event.payload.number == steps.open_pr.output.number",
    });
  });
});

describe("decideStepRunState", () => {
  it("reads a running record whose session asks as waiting, and a completed one as done", () => {
    assert.strictEqual(decideStepRunState("running", true), "waiting");
    assert.strictEqual(decideStepRunState("running", false), "working");
    assert.strictEqual(decideStepRunState("completed", false), "done");
    // Only a running record can wait on the user.
    assert.strictEqual(decideStepRunState("failed", true), "failed");
    assert.strictEqual(decideStepRunState("unreached", false), "unreached");
  });
});

describe("buildRunOverlay", () => {
  const START = "2026-09-24T12:00:00.000Z";
  const at = (ms: number): string => new Date(Date.parse(START) + ms).toISOString();
  const RUN_ID = "01a06d02-c111-7a0e-8b3d-9c1f1f3a9c2e";
  const REVIEW_SESSION_ID = "01a06d02-c111-7a0e-8b3d-9c1f00005e55";
  const DRAWING = buildGraphDrawing(RELEASE, AGENTS, ACTIONS);

  /** Returns a completed record of `stepId`'s visit `iteration`, from `from` to `to` milliseconds after the start. */
  const complete = (stepId: string, iteration: number, from: number, to: number): StepRecord => ({
    stepId,
    iteration,
    status: "completed",
    startedAt: at(from),
    finishedAt: at(to),
    output: { number: 12 },
  });

  const RUN_FIELDS = {
    id: RUN_ID,
    workflowId: null,
    plan: RELEASE,
    inputs: {},
    origin: { kind: "trigger", triggerId: "labeled", eventId: 1 },
    subscriptions: [],
    createdAt: START,
  } as const;

  /**
   * The label started the run; `notes` is done, `review` asked for changes
   * once, `fix` made them, and `review` runs again. The edges by index:
   * 0 notes>open_pr, 1 review>open_pr, 2 review>fix, 3 fix>review (max 3),
   * 4 merged>announce.
   */
  const REVIEWING: Run = {
    ...RUN_FIELDS,
    status: "running",
    startedAt: START,
    steps: [
      complete("notes", 1, 0, 10),
      complete("review", 1, 0, 20),
      complete("fix", 1, 25, 40),
      {
        stepId: "review",
        iteration: 2,
        status: "running",
        startedAt: at(45),
        sessionId: REVIEW_SESSION_ID,
      },
    ],
    edgeTraversals: [1, 0, 1, 1, 0],
  };

  const COMMAND_REQUEST: OpenRequest = {
    requestId: "r-1",
    itemId: "tool-1",
    decisions: ["allow", "deny"],
    kind: "command_approval",
    detail: { command: "npm audit fix --force" },
  };
  const ASKING = buildSession({
    id: REVIEW_SESSION_ID,
    runId: RUN_ID,
    stepId: "review",
    openRequests: [COMMAND_REQUEST],
  });

  /** Returns each node's state, with its iteration label when it has one. */
  const listNodeStates = (overlay: RunOverlay): Record<string, string> =>
    Object.fromEntries(
      [...overlay.nodes].map(([id, node]) => [
        id,
        node.iterationLabel === undefined ? node.state : `${node.state} ${node.iterationLabel}`,
      ]),
    );

  /** Returns each edge's travel by its id. */
  const listEdgeTravel = (overlay: RunOverlay): Record<string, string> =>
    Object.fromEntries([...overlay.edges].map(([id, edge]) => [id, edge.travel]));

  /** Returns the run's state at the edge `id`, failing the test when there is none. */
  const findEdgeOnRun = (overlay: RunOverlay, id: string): EdgeOnRun => {
    const edge = overlay.edges.get(id);
    assert.isDefined(edge, `no state for ${id}`);
    return edge;
  };

  it("marks every node and edge of the drawing, by its id", () => {
    const overlay = buildRunOverlay(DRAWING, REVIEWING, []);
    assert.deepStrictEqual(
      [...overlay.nodes.keys()],
      DRAWING.nodes.map((node) => node.id),
    );
    assert.deepStrictEqual(
      [...overlay.edges.keys()],
      DRAWING.edges.map((edge) => edge.id),
    );
  });

  it("marks where a live run is at each node, and counts a step's visits", () => {
    assert.deepStrictEqual(listNodeStates(buildRunOverlay(DRAWING, REVIEWING, [])), {
      labeled: "fired",
      friday: "quiet",
      // A step runs, so the run does not listen for the signal yet.
      merged: "quiet",
      notes: "done",
      review: "working ×2",
      fix: "done",
      open_pr: "unreached",
      announce: "unreached",
    });
  });

  it("marks a running step whose session asks as waiting", () => {
    const overlay = buildRunOverlay(DRAWING, REVIEWING, [ASKING]);
    assert.strictEqual(overlay.nodes.get("review")?.state, "waiting");
    // The same session with nothing to ask is working.
    const quiet = buildRunOverlay(DRAWING, REVIEWING, [{ ...ASKING, openRequests: [] }]);
    assert.strictEqual(quiet.nodes.get("review")?.state, "working");
  });

  it("gives an edge through the junction the furthest travel of the edges it stands for", () => {
    assert.deepStrictEqual(listEdgeTravel(buildRunOverlay(DRAWING, REVIEWING, [])), {
      // `labeled` led to `notes`, which is done, and to `review`, which runs.
      "bus in labeled": "active",
      "bus in friday": "notYet",
      "bus out notes": "fired",
      "bus out review": "active",
      "plan 0": "fired",
      "plan 1": "notYet",
      "plan 2": "fired",
      "plan 3": "active",
      "plan 4": "notYet",
      "correlation open_pr merged": "notYet",
    });
  });

  it("counts a loop edge's traversals out of its limit", () => {
    const overlay = buildRunOverlay(DRAWING, REVIEWING, []);
    assert.deepStrictEqual(findEdgeOnRun(overlay, "plan 3"), {
      travel: "active",
      isFailedEdge: false,
      traversalBadge: "1/3",
    });
    assert.isUndefined(findEdgeOnRun(overlay, "plan 2").traversalBadge);
  });

  it("marks the edge a run failed at, and leaves an ended run's untaken edges not taken", () => {
    const loop = [1, 2, 3, 4].flatMap((visit) => [
      complete("review", visit, visit * 100, visit * 100 + 20),
      complete("fix", visit, visit * 100 + 30, visit * 100 + 50),
    ]);
    const failed: Run = {
      ...RUN_FIELDS,
      origin: { kind: "manual", actor: "user" },
      status: "failed",
      failureReason: "iteration-limit",
      failedStepId: "fix",
      failedEdge: { index: 3, message: "The run would follow fix → review a fourth time." },
      startedAt: START,
      finishedAt: at(500),
      steps: [complete("notes", 1, 0, 10), ...loop],
      edgeTraversals: [1, 0, 4, 3, 0],
    };
    const overlay = buildRunOverlay(DRAWING, failed, []);
    assert.deepStrictEqual(findEdgeOnRun(overlay, "plan 3"), {
      travel: "fired",
      isFailedEdge: true,
      traversalBadge: "3/3",
    });
    assert.deepInclude(listNodeStates(overlay), {
      labeled: "quiet",
      friday: "quiet",
      review: "done ×4",
      open_pr: "unreached",
    });
    assert.deepInclude(listEdgeTravel(overlay), {
      "bus in labeled": "notTaken",
      "bus in friday": "notTaken",
      "plan 1": "notTaken",
      "correlation open_pr merged": "notTaken",
    });
  });

  it("takes the stub to the end once its terminal step is done, and never once the run ended without it", () => {
    assert.deepStrictEqual(
      [...buildRunOverlay(DRAWING, REVIEWING, []).endStubs],
      [["announce", "notYet"]],
    );
    const announced: Run = {
      ...REVIEWING,
      status: "completed",
      finishedAt: at(90),
      steps: [...REVIEWING.steps.slice(0, 3), complete("announce", 1, 60, 90)],
    };
    assert.strictEqual(buildRunOverlay(DRAWING, announced, []).endStubs.get("announce"), "fired");
    const cancelled: Run = { ...REVIEWING, status: "cancelled", finishedAt: at(90) };
    assert.strictEqual(
      buildRunOverlay(DRAWING, cancelled, []).endStubs.get("announce"),
      "notTaken",
    );
  });

  it("listens for a signal once the run waits, and marks it fired once it has fired", () => {
    const opened: Run = {
      ...RUN_FIELDS,
      status: "running",
      startedAt: START,
      steps: [
        complete("notes", 1, 0, 10),
        complete("review", 1, 0, 20),
        complete("open_pr", 1, 30, 40),
      ],
      edgeTraversals: [1, 1, 0, 0, 0],
    };
    const listening = buildRunOverlay(DRAWING, opened, []);
    assert.strictEqual(listening.nodes.get("merged")?.state, "listening");
    // The pull request is open, so the run has what it matches the signal on.
    assert.strictEqual(findEdgeOnRun(listening, "correlation open_pr merged").travel, "fired");

    const merged: Run = {
      ...opened,
      steps: [
        ...opened.steps,
        complete("merged", 1, 50, 50),
        { stepId: "announce", iteration: 1, status: "running", startedAt: at(55) },
      ],
      edgeTraversals: [1, 1, 0, 0, 1],
    };
    const overlay = buildRunOverlay(DRAWING, merged, []);
    assert.strictEqual(overlay.nodes.get("merged")?.state, "fired");
    assert.strictEqual(overlay.nodes.get("announce")?.state, "working");
    assert.strictEqual(findEdgeOnRun(overlay, "plan 4").travel, "active");
  });
});
