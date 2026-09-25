/**
 * An entry step is a step with `entry: true`, or a step with no incoming
 * edges. The graph's nodes and edges have no guaranteed order, so each test
 * sorts them before comparing.
 */
import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@hercule/contract";
import {
  abbreviateEdgeCondition,
  buildWorkflowGraph,
  shortenCondition,
} from "@hercule/client-core";

type WorkflowGraph = ReturnType<typeof buildWorkflowGraph>;

/** An Agent id. The graph ignores it. */
const AGENT_ID = "0199e0e7-1111-7000-8000-0000000000ab";

/** Returns the graph with its nodes and edges sorted. */
const sortGraph = (graph: WorkflowGraph): WorkflowGraph => ({
  nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)),
  edges: [...graph.edges].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
});

describe("buildWorkflowGraph", () => {
  it("builds a linear workflow, with an edge from the start trigger to the first step", () => {
    const definition: WorkflowDefinition = {
      name: "Review labelled pull requests",
      triggers: [{ id: "labelled", kind: "start", source: { kind: "github.pr.labeled" } }],
      steps: [
        { id: "open_task", kind: "action", action: "task.create" },
        { id: "review", kind: "agent", agent: AGENT_ID, prompt: "Review the pull request." },
        { id: "comment", kind: "action", action: "task.update" },
      ],
      edges: [
        { from: "open_task", to: "review" },
        { from: "review", to: "comment", condition: "steps.review.output.approved" },
      ],
    };

    expect(sortGraph(buildWorkflowGraph(definition))).toEqual({
      nodes: [
        { id: "comment", kind: "action" },
        { id: "labelled", kind: "start" },
        { id: "open_task", kind: "action" },
        { id: "review", kind: "agent" },
      ],
      edges: [
        // No step leads into open_task, so the run starts there.
        { from: "labelled", to: "open_task" },
        { from: "open_task", to: "review" },
        { from: "review", to: "comment", condition: "steps.review.output.approved" },
      ],
    });
  });

  it("starts a loop at the step marked entry, not at a step reached only by a signal", () => {
    // Every step in the loop has an incoming edge, so only `entry: true` marks
    // where the run starts. task_done waits for its signal.
    const definition: WorkflowDefinition = {
      name: "Implement a task",
      triggers: [
        { id: "assigned", kind: "start", source: { kind: "task.updated" } },
        {
          id: "checks_failed",
          kind: "signal",
          source: { kind: "github.checks.failed", connectionId: "any" },
          correlation: { event: "event.payload.prNumber", run: "steps.open_pr.output.prNumber" },
        },
        {
          id: "pr_merged",
          kind: "signal",
          source: { kind: "github.pr.merged", connectionId: "any" },
          correlation: { event: "event.payload.prNumber", run: "steps.open_pr.output.prNumber" },
        },
      ],
      steps: [
        {
          id: "implement",
          kind: "agent",
          agent: AGENT_ID,
          prompt: "Implement the task.",
          entry: true,
        },
        { id: "open_pr", kind: "action", action: "task.update" },
        { id: "review", kind: "agent", agent: AGENT_ID, prompt: "Review the pull request." },
        { id: "task_done", kind: "action", action: "task.update", terminal: true },
      ],
      edges: [
        { from: "implement", to: "open_pr" },
        { from: "open_pr", to: "review" },
        {
          from: "review",
          to: "implement",
          condition: "steps.review.output.approved == false",
          maxTraversals: 3,
        },
        { from: "checks_failed", to: "implement" },
        { from: "pr_merged", to: "task_done" },
      ],
    };

    const graph = buildWorkflowGraph(definition);

    expect(graph.nodes).toHaveLength(7);
    expect(graph.edges).toHaveLength(6);
    expect(sortGraph(graph)).toEqual({
      nodes: [
        { id: "assigned", kind: "start" },
        { id: "checks_failed", kind: "signal" },
        { id: "implement", kind: "agent" },
        { id: "open_pr", kind: "action" },
        { id: "pr_merged", kind: "signal" },
        { id: "review", kind: "agent" },
        // A terminal step ends the run when it completes, and its card says so.
        { id: "task_done", kind: "action", terminal: true },
      ],
      edges: [
        { from: "assigned", to: "implement" },
        { from: "checks_failed", to: "implement" },
        { from: "implement", to: "open_pr" },
        { from: "open_pr", to: "review" },
        { from: "pr_merged", to: "task_done" },
        {
          from: "review",
          to: "implement",
          condition: "steps.review.output.approved == false",
          maxTraversals: 3,
        },
      ],
    });
  });

  it("adds an edge from each start trigger to each entry step, and none from a signal trigger", () => {
    const definition: WorkflowDefinition = {
      name: "Triage and audit",
      triggers: [
        { id: "labelled", kind: "start", source: { kind: "github.pr.labeled" } },
        {
          id: "nightly",
          kind: "start",
          source: { kind: "cron.tick" },
          schedule: "0 3 * * *",
        },
        {
          id: "merged",
          kind: "signal",
          source: { kind: "github.pr.merged", connectionId: "any" },
          correlation: { event: "event.payload.prNumber", run: "inputs.prNumber" },
        },
      ],
      steps: [
        { id: "triage", kind: "action", action: "task.create" },
        { id: "audit", kind: "action", action: "task.query" },
        { id: "report", kind: "action", action: "task.update" },
      ],
      edges: [
        { from: "triage", to: "report" },
        { from: "merged", to: "report" },
      ],
    };

    expect(sortGraph(buildWorkflowGraph(definition)).edges).toEqual([
      { from: "labelled", to: "audit" },
      { from: "labelled", to: "triage" },
      { from: "merged", to: "report" },
      { from: "nightly", to: "audit" },
      { from: "nightly", to: "triage" },
      { from: "triage", to: "report" },
    ]);
  });

  it("finds entry steps using only valid edges, as the controller does", () => {
    // Validation rejects an edge from a start trigger and an edge from an
    // unknown id. Neither counts as an incoming edge, so both steps are entry
    // steps. The edge written from the start trigger is still drawn. The edge
    // from the unknown id cannot be drawn.
    const definition: WorkflowDefinition = {
      name: "Triage",
      triggers: [{ id: "labelled", kind: "start", source: { kind: "github.pr.labeled" } }],
      steps: [
        { id: "triage", kind: "action", action: "task.create" },
        { id: "report", kind: "action", action: "task.update" },
      ],
      edges: [
        { from: "labelled", to: "triage" },
        { from: "nowhere", to: "report" },
      ],
    };

    expect(sortGraph(buildWorkflowGraph(definition)).edges).toEqual([
      { from: "labelled", to: "report" },
      { from: "labelled", to: "triage" },
      { from: "labelled", to: "triage" },
    ]);
  });
});

describe("abbreviateEdgeCondition", () => {
  it("removes every output prefix of the edge's source step", () => {
    expect(
      abbreviateEdgeCondition({
        from: "review",
        to: "implement",
        condition:
          'has(steps.review) && steps.review.output.verdict == "reject" && steps.review.output.score < 3',
      }),
    ).toBe('has(steps.review) && verdict == "reject" && score < 3');
  });

  it("keeps another step's output prefix, and a name that only ends like the prefix", () => {
    expect(
      abbreviateEdgeCondition({
        from: "review",
        to: "merge",
        condition: "steps.checks.output.passed && inputs.steps.review.output.x",
      }),
    ).toBe("steps.checks.output.passed && inputs.steps.review.output.x");
  });

  it("returns undefined for an edge with no condition", () => {
    expect(abbreviateEdgeCondition({ from: "review", to: "merge" })).toBeUndefined();
  });
});

describe("shortenCondition", () => {
  it("returns a condition that fits unchanged", () => {
    expect(shortenCondition("size(items) > 0")).toBe("size(items) > 0");
  });

  it("keeps the operator and the right-hand side of a long comparison", () => {
    expect(shortenCondition("size(items) < inputs.target")).toBe("… < inputs.target");
    expect(shortenCondition("size(items) >= inputs.target")).toBe("… >= inputs.target");
  });

  it("keeps the last clause of a long condition with several clauses", () => {
    expect(shortenCondition('has(steps.review) && verdict == "reject" && score < 3')).toBe(
      "… && score < 3",
    );
  });

  it("cuts at the last comparison when the last clause does not fit", () => {
    expect(shortenCondition("has(steps.a) && size(items) >= inputs.target")).toBe(
      "… >= inputs.target",
    );
  });

  it("ignores operators inside brackets and strings", () => {
    expect(shortenCondition('size(a.filter(x, x > 2)) == "b > c && d"')).toBe('… == "b > c && d"');
  });

  it("keeps the last characters when the end after the operator is still too long", () => {
    expect(shortenCondition("x == inputs.a_rather_long_field_name")).toBe(
      "…_rather_long_field_name",
    );
    expect(shortenCondition("steps.checks.output.passed_all")).toBe("…hecks.output.passed_all");
  });
});
