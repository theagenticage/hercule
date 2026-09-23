/**
 * The graph that the editor's preview draws from a workflow's definition: one
 * node for each trigger and each step, one edge for each entry of `edges`, and
 * an edge from each start trigger to each entry step.
 */
import { listEntrySteps, type WorkflowDefinition } from "@hercule/contract";

/** What a node of the graph stands for: a trigger or a step, of one kind. */
type WorkflowGraphNodeKind = "start" | "signal" | "action" | "agent";

export interface WorkflowGraphNode {
  /** The id the text gives the trigger or the step. */
  readonly id: string;
  readonly kind: WorkflowGraphNodeKind;
}

/** A way through the graph, with the condition and the cap that the text gives it. */
export interface WorkflowGraphEdge {
  readonly from: string;
  readonly to: string;
  readonly condition?: string;
  readonly maxTraversals?: number;
}

export interface WorkflowGraph {
  readonly nodes: ReadonlyArray<WorkflowGraphNode>;
  readonly edges: ReadonlyArray<WorkflowGraphEdge>;
}

/**
 * The graph of a definition. A run starts at every entry step, so each start
 * trigger leads into each entry step, and the preview shows where a run
 * begins.
 *
 * An edge whose end names no trigger and no step cannot be drawn, so the
 * graph leaves it out. The check of the definition refuses such an edge at
 * its path, so the author learns of it there.
 */
export const buildWorkflowGraph = (definition: WorkflowDefinition): WorkflowGraph => {
  const triggers = definition.triggers ?? [];
  const nodes = [...triggers, ...definition.steps].map(({ id, kind }) => ({ id, kind }));
  const ids = new Set(nodes.map((node) => node.id));
  const entrySteps = listEntrySteps(definition);
  return {
    nodes,
    edges: [
      ...triggers
        .filter((trigger) => trigger.kind === "start")
        .flatMap((trigger) => entrySteps.map((step) => ({ from: trigger.id, to: step.id }))),
      ...(definition.edges ?? []).filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
    ],
  };
};

/**
 * The condition of an edge as the graph shows it, or `undefined` for an edge
 * with no condition. A condition often reads the output of the step or the
 * signal trigger that the edge leaves, as in
 * `steps.review.output.verdict == "approve"`. The edge starts there already,
 * so the graph leaves out `steps.<from>.output.` and shows
 * `verdict == "approve"`. The part that is left is the part in which two
 * branches of one step differ.
 */
export const abbreviateEdgeCondition = (edge: WorkflowGraphEdge): string | undefined =>
  edge.condition?.replace(new RegExp(`(?<![\\w.])steps\\.${edge.from}\\.output\\.`, "g"), "");
