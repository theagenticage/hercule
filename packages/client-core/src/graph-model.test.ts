import { assert, describe, it } from "vitest";
import type { WorkflowDefinition } from "@hercule/contract";
import { BUS_ID, buildGraphDrawing, type GraphEdge } from "./graph-model";

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
    assert.isTrue(byId.get("friday")?.firesOnSchedule);
    assert.isFalse(byId.get("labeled")?.firesOnSchedule);
    assert.isTrue(byId.get("open_pr")?.joinsAll);
    assert.isTrue(byId.get("announce")?.terminal);
  });

  it("fans two start triggers out to two entry steps through one junction", () => {
    const { edges, busId } = buildGraphDrawing(RELEASE, AGENTS, ACTIONS);
    assert.strictEqual(busId, BUS_ID);
    assert.deepStrictEqual(
      edges.filter((edge) => edge.to === BUS_ID).map((edge) => edge.from),
      ["labeled", "friday"],
    );
    assert.deepStrictEqual(
      edges.filter((edge) => edge.from === BUS_ID).map((edge) => edge.to),
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
