import { listEntrySteps, type WorkflowDefinition } from "@hercule/contract";

/** A trigger kind (`start`, `signal`) or a step kind (`action`, `agent`). */
type WorkflowGraphNodeKind = "start" | "signal" | "action" | "agent";

export interface WorkflowGraphNode {
  /** The trigger's or step's id. */
  readonly id: string;
  readonly kind: WorkflowGraphNodeKind;
}

/** An edge of the graph, with the condition and traversal limit from the definition. */
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
 * Builds the graph that the editor's preview draws for a workflow definition:
 * - one node for each trigger and each step,
 * - one edge for each entry in `edges`,
 * - an edge from each start trigger to each entry step, because a run starts
 *   at every entry step. These edges show where a run begins.
 *
 * An edge whose `from` or `to` is not a trigger or step id cannot be drawn,
 * so it is left out. Validation reports that edge as an error at its path.
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
 * Returns an edge's condition shortened for display, or `undefined` for an
 * edge with no condition.
 *
 * A condition often reads the output of the edge's source step, as in
 * `steps.review.output.verdict == "approve"`. The graph already shows that
 * the edge leaves `review`, so the prefix `steps.review.output.` is removed,
 * leaving `verdict == "approve"`. What remains is the part that differs
 * between two branches from the same step.
 */
export const abbreviateEdgeCondition = (edge: WorkflowGraphEdge): string | undefined =>
  edge.condition?.replace(new RegExp(`(?<![\\w.])steps\\.${edge.from}\\.output\\.`, "g"), "");
