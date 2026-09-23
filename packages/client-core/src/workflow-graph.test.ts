/**
 * The graph that the editor's preview draws from a workflow's definition: one
 * node for each step and each trigger, one edge for each entry of `edges`, and
 * an edge from each start trigger to each entry step. An entry step is a step
 * with `entry: true`, or a step with no incoming edges. The run starts at the
 * entry steps, so the preview shows where each start trigger leads.
 *
 * The graph promises no order, so each test sorts it before it compares.
 */
import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@hercule/contract";
import { abbreviateEdgeCondition, buildWorkflowGraph } from "@hercule/client-core";

type WorkflowGraph = ReturnType<typeof buildWorkflowGraph>;

/** An Agent's id. The graph does not read it. */
const AGENT_ID = "0199e0e7-1111-7000-8000-0000000000ab";

/** The nodes and edges of a graph in one fixed order. */
const sortGraph = (graph: WorkflowGraph): WorkflowGraph => ({
  nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)),
  edges: [...graph.edges].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
});

describe("buildWorkflowGraph", () => {
  it("draws a linear workflow, and the start trigger into its first step", () => {
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

  it("starts a loop at the step marked entry, and not at a step that only a signal leads into", () => {
    // Every step of the loop has an incoming edge, so only `entry: true` says
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
        { id: "task_done", kind: "action" },
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

  it("draws each start trigger into each entry step, and no signal trigger into any", () => {
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

  it("finds the entry steps over the edges that the check accepts, as the controller does", () => {
    // The check refuses an edge from a start trigger and an edge from an id
    // that names nothing, so neither leads into a step: both steps are entry
    // steps. The written edge from the start trigger is drawn, and the edge
    // from nothing cannot be.
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
  it("leaves out the output prefix of the step that the edge leaves, wherever the condition reads it", () => {
    expect(
      abbreviateEdgeCondition({
        from: "review",
        to: "implement",
        condition:
          'has(steps.review) && steps.review.output.verdict == "reject" && steps.review.output.score < 3',
      }),
    ).toBe('has(steps.review) && verdict == "reject" && score < 3');
  });

  it("keeps the output of another step, and a name that only ends like the prefix", () => {
    expect(
      abbreviateEdgeCondition({
        from: "review",
        to: "merge",
        condition: "steps.checks.output.passed && inputs.steps.review.output.x",
      }),
    ).toBe("steps.checks.output.passed && inputs.steps.review.output.x");
  });

  it("answers nothing for an edge with no condition", () => {
    expect(abbreviateEdgeCondition({ from: "review", to: "merge" })).toBeUndefined();
  });
});
