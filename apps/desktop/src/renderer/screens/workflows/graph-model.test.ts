import { describe, expect, it } from "vitest";
import { buildSession } from "@hercule/client-core/threads/testing";
import type { Agent, Run, StepRecord, WorkflowAction, WorkflowDefinition } from "@hercule/contract";
import { BUS_ID, buildGraphDrawing, type GraphEdge } from "./graph-model";

const AT = "2026-09-29T09:00:00.000Z";

/** Returns an Agent named `name`, with the fields no test here reads filled in. */
const buildAgent = (id: string, name: string): Agent => ({
  id,
  name,
  systemPrompt: `You are ${name}.`,
  instanceId: "i-claude",
  permissionProfileId: "p-unrestricted",
  accessMode: "approval-required",
  model: null,
  disallowedTools: [],
  unenforced: [],
  createdAt: AT,
  updatedAt: AT,
});

const AGENTS = [buildAgent("a-writer", "Writer"), buildAgent("a-reviewer", "Reviewer")];

const ACTIONS: ReadonlyArray<WorkflowAction> = [
  {
    id: "github/pr.create",
    displayName: "Open a GitHub pull request",
    description: "Opens a pull request.",
    runsIn: "controller",
    inputSchema: { type: "object" },
  },
];

/**
 * A small release: an issue label or the Friday schedule starts `notes` and
 * `review`; `review` and `fix` loop up to three times; `open_pr` waits for
 * both branches; the `merged` signal, correlated on the pull request's
 * number, leads to `announce`, which ends the run.
 *
 * The edges by index: 0 notes>open_pr, 1 review>open_pr, 2 review>fix,
 * 3 fix>review (the loop), 4 merged>announce.
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

/** Returns a completed step record. */
const complete = (
  stepId: string,
  iteration = 1,
  output: Extract<StepRecord, { status: "completed" }>["output"] = {},
): StepRecord => ({
  stepId,
  iteration,
  status: "completed",
  startedAt: AT,
  finishedAt: AT,
  output,
});

/** The fields of a run that no test here reads. */
const RUN_FIELDS = {
  id: "r-1",
  workflowId: "w-1",
  plan: RELEASE,
  inputs: {},
  origin: { kind: "trigger", triggerId: "labeled", eventId: 1 },
  subscriptions: [],
  createdAt: AT,
  startedAt: AT,
} as const;

/** The review asked for changes once and approved the fix; `notes` waits on the user. */
const WAITING: Run = {
  ...RUN_FIELDS,
  status: "running",
  steps: [
    complete("review", 1, { verdict: "changes" }),
    complete("fix"),
    complete("review", 2, { verdict: "approved" }),
    { stepId: "notes", iteration: 1, status: "running", startedAt: AT, sessionId: "s-notes" },
    { stepId: "open_pr", iteration: 1, status: "pending" },
  ],
  edgeTraversals: [0, 1, 1, 1, 0],
};

/** The pull request is open, and the run listens for it to be merged. */
const LISTENING: Run = {
  ...RUN_FIELDS,
  status: "running",
  steps: [complete("notes"), complete("review"), complete("open_pr", 1, { number: 7 })],
  edgeTraversals: [1, 1, 0, 0, 0],
};

/** The review asked for changes a fourth time, past the loop's limit. */
const OVER_LIMIT: Run = {
  ...RUN_FIELDS,
  status: "failed",
  failureReason: "iteration-limit",
  failedStepId: "review",
  failedEdge: { index: 2, message: "The run would follow review → fix a fourth time." },
  finishedAt: AT,
  steps: [complete("notes"), complete("review", 4, { verdict: "changes" })],
  edgeTraversals: [1, 0, 3, 3, 0],
};

const NOTES_SESSION = buildSession({
  id: "s-notes",
  runId: "r-1",
  stepId: "notes",
  openRequests: [
    {
      requestId: "q-1",
      itemId: "i-1",
      kind: "command_approval",
      decisions: ["allow", "deny"],
      detail: { command: "git push" },
    },
  ],
});

/** Draws the release with `run`, or with no run. */
const drawRelease = (run?: Run) =>
  buildGraphDrawing(RELEASE, run, [NOTES_SESSION], AGENTS, ACTIONS);

/** Returns the edge from `from` to `to`. */
const findEdge = (edges: ReadonlyArray<GraphEdge>, from: string, to: string): GraphEdge =>
  edges.find((edge) => edge.from === from && edge.to === to)!;

describe("buildGraphDrawing", () => {
  it("names each card's step or trigger, and what it runs or fires on", () => {
    const { nodes } = drawRelease();
    expect(Object.fromEntries(nodes.map((node) => [node.id, node.detail]))).toEqual({
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
    expect(byId.get("friday")?.firesOnSchedule).toBe(true);
    expect(byId.get("open_pr")?.joinsAll).toBe(true);
    expect(byId.get("announce")?.terminal).toBe(true);
    expect(new Set(nodes.map((node) => node.state))).toEqual(new Set(["none"]));
  });

  it("fans two start triggers out to two entry steps through one junction", () => {
    const { edges, busId } = drawRelease();
    expect(busId).toBe(BUS_ID);
    expect(edges.filter((edge) => edge.to === BUS_ID).map((edge) => edge.from)).toEqual([
      "labeled",
      "friday",
    ]);
    expect(edges.filter((edge) => edge.from === BUS_ID).map((edge) => edge.to)).toEqual([
      "notes",
      "review",
    ]);
  });

  it("connects a one-trigger workflow's trigger to its entry step directly", () => {
    const definition: WorkflowDefinition = {
      name: "Assign",
      triggers: [{ id: "opened", kind: "start", on: { kind: "github.pr.opened" } }],
      steps: [{ id: "pick", kind: "agent", agent: "a-reviewer", prompt: "Pick a reviewer." }],
    };
    const drawing = buildGraphDrawing(definition, undefined, [], AGENTS, ACTIONS);
    expect(drawing.busId).toBeUndefined();
    expect(findEdge(drawing.edges, "opened", "pick")).toBeDefined();
  });

  it("labels conditions without their source step's prefix, and a loop with its limit", () => {
    const { edges } = drawRelease();
    expect(findEdge(edges, "review", "open_pr").condition).toBe('verdict == "approved"');
    expect(findEdge(edges, "fix", "review")).toMatchObject({ limit: "≤ 3", maxTraversals: 3 });
  });

  it("draws the step a signal correlates on as a dashed edge to the signal", () => {
    const edge = findEdge(drawRelease().edges, "open_pr", "merged");
    expect(edge).toMatchObject({ kind: "correlation", condition: "number" });
  });

  it("draws a run whose step waits on the user, and a join that waits for it", () => {
    const { nodes, edges } = drawRelease(WAITING);
    expect(Object.fromEntries(nodes.map((node) => [node.id, node.state]))).toEqual({
      labeled: "fired",
      friday: "quiet",
      merged: "quiet",
      notes: "waiting",
      review: "done",
      fix: "done",
      open_pr: "pending",
      announce: "unreached",
    });
    expect(nodes.find((node) => node.id === "review")?.iterationLabel).toBe("×2");
    expect(findEdge(edges, "fix", "review").limit).toBe("1/3");
    // The junction's edge in carries the run to notes, which still runs.
    expect(findEdge(edges, "labeled", BUS_ID).travel).toBe("active");
    expect(findEdge(edges, "friday", BUS_ID).travel).toBe("notYet");
    expect(findEdge(edges, BUS_ID, "notes").travel).toBe("active");
    expect(findEdge(edges, "open_pr", "merged").travel).toBe("notYet");
  });

  it("draws a run that listens for its pull request to be merged", () => {
    const { nodes, edges } = drawRelease(LISTENING);
    expect(nodes.find((node) => node.id === "merged")?.state).toBe("listening");
    expect(findEdge(edges, "open_pr", "merged").travel).toBe("fired");
  });

  it("marks the edge a run failed at", () => {
    const { edges } = drawRelease(OVER_LIMIT);
    expect(findEdge(edges, "review", "fix").isFailedEdge).toBe(true);
    expect(edges.filter((edge) => edge.isFailedEdge)).toHaveLength(1);
  });
});
