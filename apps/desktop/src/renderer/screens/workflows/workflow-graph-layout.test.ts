/**
 * Tests that the graph's sizes lay out Ship release, the Bureau book's
 * workflow, at the book's coordinates.
 */
import { assert, describe, it } from "vitest";
import type { WorkflowDefinition } from "@hercule/contract";
import { buildGraphDrawing } from "@hercule/client-core/graph-model";
import { layOutGraphDrawing } from "./workflow-graph-layout";

const AGENTS = [
  { id: "a-writer", name: "Writer" },
  { id: "a-auditor", name: "Auditor" },
  { id: "a-tester", name: "Tester" },
  { id: "a-reviewer", name: "Reviewer" },
  { id: "a-coder", name: "Coder" },
];

const ACTIONS = [
  { id: "github/pr.create", displayName: "Open a GitHub pull request" },
  { id: "notification.create", displayName: "Send a notification" },
];

/** Ship release as the book draws it: two start triggers, four entry steps, a review loop and a signal. */
const SHIP_RELEASE: WorkflowDefinition = {
  name: "Ship release",
  triggers: [
    { id: "release_issue", kind: "start", on: { kind: "github.issue.labeled" } },
    { id: "release_train", kind: "start", on: { schedule: "0 14 * * 5" } },
    {
      id: "pr_merged",
      kind: "signal",
      on: { kind: "github.pr.merged" },
      correlation: { event: "event.payload.number", run: "steps.open_pr.output.number" },
    },
  ],
  steps: [
    { id: "changelog", kind: "agent", agent: "a-writer", prompt: "Write the changelog." },
    { id: "security", kind: "agent", agent: "a-auditor", prompt: "Audit the dependencies." },
    { id: "test", kind: "agent", agent: "a-tester", prompt: "Run the tests." },
    { id: "review", kind: "agent", agent: "a-reviewer", prompt: "Review.", entry: true },
    { id: "fix", kind: "agent", agent: "a-coder", prompt: "Fix." },
    { id: "open_pr", kind: "action", action: "github/pr.create", join: "all" },
    { id: "announce", kind: "agent", agent: "a-writer", prompt: "Announce." },
    { id: "notify", kind: "action", action: "notification.create", terminal: true },
  ],
  edges: [
    { from: "changelog", to: "open_pr" },
    { from: "test", to: "open_pr" },
    { from: "security", to: "open_pr" },
    { from: "review", to: "open_pr", condition: 'steps.review.output.verdict == "approved"' },
    { from: "review", to: "fix", condition: 'steps.review.output.verdict == "changes"' },
    { from: "fix", to: "review", maxTraversals: 3 },
    { from: "pr_merged", to: "announce" },
    { from: "announce", to: "notify" },
  ],
};

describe("layOutGraphDrawing", () => {
  it("places Ship release's cards where the book draws them", () => {
    const drawing = buildGraphDrawing(SHIP_RELEASE, AGENTS, ACTIONS);
    const { layout, size } = layOutGraphDrawing(drawing);
    const placed = (id: string) => {
      const point = layout.nodes.get(id);
      return point === undefined ? undefined : [point.x, point.y];
    };
    assert.deepStrictEqual(
      Object.fromEntries(drawing.nodes.map((node) => [node.id, placed(node.id)])),
      {
        release_issue: [0, 84.25],
        release_train: [0, 152.25],
        pr_merged: [883, 108.5],
        changelog: [256, 209.5],
        security: [256, 141.5],
        test: [256, 73.5],
        review: [256, 5.5],
        fix: [619, 0],
        open_pr: [619, 108.5],
        announce: [1099, 108.5],
        notify: [1315, 108.5],
      },
    );
    assert.deepStrictEqual(size, { width: 1511, height: 257.5 });
    // The junction has no width; the graph draws its dot at the middle of its height.
    assert.deepStrictEqual(layout.nodes.get(drawing.busId!), { x: 216, y: 130.25 });
  });

  it("centres each edge's label where the book draws it", () => {
    const drawing = buildGraphDrawing(SHIP_RELEASE, AGENTS, ACTIONS);
    const { layout } = layOutGraphDrawing(drawing);
    const labels = drawing.edges.flatMap((edge) => {
      const centre = layout.edges.get(edge.id)?.label;
      return centre === undefined ? [] : [[edge.condition ?? edge.limit, centre.x, centre.y]];
    });
    assert.deepStrictEqual(labels, [
      ['verdict == "approved"', 525.5, 67.25],
      ['verdict == "changes"', 525.5, 40.25],
      ["≤ 3", 525.5, 13.25],
      ["number", 839, 132.5],
    ]);
  });
});
