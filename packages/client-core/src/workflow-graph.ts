import { listEntrySteps, type WorkflowDefinition } from "@hercule/contract";

/** A trigger kind (`start`, `signal`) or a step kind (`action`, `agent`). */
type WorkflowGraphNodeKind = "start" | "signal" | "action" | "agent";

export interface WorkflowGraphNode {
  /** The trigger's or step's id. */
  readonly id: string;
  readonly kind: WorkflowGraphNodeKind;
  /** Set on a terminal step, which ends the run when it completes. */
  readonly terminal?: true;
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
 * - one node for each trigger and each step, a terminal step's marked so,
 * - one edge for each entry in `edges`,
 * - an edge from each start trigger to each entry step, because a run starts
 *   at every entry step. These edges show where a run begins.
 *
 * An edge whose `from` or `to` is not a trigger or step id cannot be drawn,
 * so it is left out. Validation reports that edge as an error at its path.
 */
export const buildWorkflowGraph = (definition: WorkflowDefinition): WorkflowGraph => {
  const { nodes, edges } = buildIndexedWorkflowGraph(definition);
  return { nodes, edges: edges.map(({ edge }) => edge) };
};

/** A drawn edge, with its index in the definition's `edges`. */
export interface IndexedWorkflowGraphEdge {
  readonly edge: WorkflowGraphEdge;
  /** `undefined` for an edge from a trigger, which is not in the definition's `edges`. */
  readonly planEdgeIndex: number | undefined;
}

/** A workflow graph whose edges carry their index in the definition's `edges`. */
export interface IndexedWorkflowGraph {
  readonly nodes: ReadonlyArray<WorkflowGraphNode>;
  readonly edges: ReadonlyArray<IndexedWorkflowGraphEdge>;
}

/**
 * Builds the graph that `buildWorkflowGraph` returns, with each edge's index
 * in the definition's `edges`. A run counts how often it followed each edge
 * by that index.
 */
export const buildIndexedWorkflowGraph = (definition: WorkflowDefinition): IndexedWorkflowGraph => {
  const triggers = definition.triggers ?? [];
  const nodes: ReadonlyArray<WorkflowGraphNode> = [
    ...triggers.map(({ id, kind }) => ({ id, kind })),
    ...definition.steps.map(({ id, kind, terminal }) =>
      terminal === true ? { id, kind, terminal } : { id, kind },
    ),
  ];
  const ids = new Set(nodes.map((node) => node.id));
  const entrySteps = listEntrySteps(definition);
  return {
    nodes,
    edges: [
      ...triggers
        .filter((trigger) => trigger.kind === "start")
        .flatMap((trigger) =>
          entrySteps.map((step) => ({
            edge: { from: trigger.id, to: step.id },
            planEdgeIndex: undefined,
          })),
        ),
      ...(definition.edges ?? []).flatMap((edge, planEdgeIndex) =>
        ids.has(edge.from) && ids.has(edge.to) ? [{ edge, planEdgeIndex }] : [],
      ),
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
 *
 * Unlike `shortenCondition`, which cuts a condition to a fixed length, this
 * function removes only the source step's own prefix and keeps every other
 * character.
 */
export const abbreviateEdgeCondition = (edge: WorkflowGraphEdge): string | undefined =>
  edge.condition?.replace(new RegExp(`(?<![\\w.])steps\\.${edge.from}\\.output\\.`, "g"), "");

/** The operators that join the clauses of a condition. */
const LOGICAL_OPERATORS = ["&&", "||"];
/** The comparison operators, the two-character ones first so `>=` is not read as `>`. */
const COMPARISON_OPERATORS = ["==", "!=", ">=", "<=", "<", ">"];

/**
 * Returns the positions in `condition` where each of `operators` starts,
 * skipping any operator inside brackets or inside a quoted string.
 */
const findTopLevelOperators = (condition: string, operators: readonly string[]): number[] => {
  const positions: number[] = [];
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < condition.length; index++) {
    const character = condition[index]!;
    if (quote !== undefined) {
      if (character === "\\") index++;
      else if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") quote = character;
    else if ("([{".includes(character)) depth++;
    else if (")]}".includes(character)) depth--;
    else if (depth === 0) {
      const operator = operators.find((candidate) => condition.startsWith(candidate, index));
      if (operator === undefined) continue;
      positions.push(index);
      index += operator.length - 1;
    }
  }
  return positions;
};

/**
 * The most characters of a condition an edge's label shows. The label's
 * tooltip holds the full condition.
 */
const MAX_CONDITION_CHARACTERS = 24;

/**
 * Shortens a condition to at most `MAX_CONDITION_CHARACTERS` characters, for
 * an edge's label. Returns the condition unchanged when it fits.
 *
 * A longer condition keeps its end, after an ellipsis, because two branches
 * from the same step usually differ at the end of their conditions. Where it
 * can, the cut falls just before an operator, so the label never starts
 * inside a name. The first of these that fits is taken:
 *
 * - the end from the last `&&` or `||`, the last clause whole:
 *   `… && score < 3`;
 * - the end from the last comparison, its operator and right-hand side:
 *   `… >= inputs.target`;
 * - the condition's last characters, as many as fit.
 *
 * Unlike `abbreviateEdgeCondition`, which removes the source step's prefix
 * and knows nothing about length, this function knows nothing about the
 * edge and only cuts the text to fit.
 */
export const shortenCondition = (condition: string): string => {
  const characters = [...condition];
  if (characters.length <= MAX_CONDITION_CHARACTERS) return condition;
  const cuts = [
    findTopLevelOperators(condition, LOGICAL_OPERATORS).at(-1),
    findTopLevelOperators(condition, COMPARISON_OPERATORS).at(-1),
  ];
  for (const cut of cuts) {
    if (cut === undefined) continue;
    const shortened = `… ${condition.slice(cut)}`;
    if ([...shortened].length <= MAX_CONDITION_CHARACTERS) return shortened;
  }
  return `…${characters.slice(1 - MAX_CONDITION_CHARACTERS).join("")}`;
};
