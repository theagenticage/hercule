/**
 * Validates the graph of a workflow definition: which nodes each edge may
 * connect, and these rules about the graph as a whole:
 *
 * - no two edges have the same `from` and `to`;
 * - every loop has an edge with `maxTraversals`;
 * - a step inside a loop does not use `join: all`;
 * - an entry step does not use `join: all`;
 * - at least one step is an entry step;
 * - every step can be reached from an entry step or a signal trigger.
 *
 * The whole-graph rules look at all edges together, while the other checks in
 * `./validation` look at one part of the definition at a time. That is why the
 * graph checks have their own module.
 */
import {
  joinNames,
  listEntrySteps,
  quoteAuthorText,
  type Issue,
  type WorkflowDefinition,
} from "@hercule/contract";

type Edge = NonNullable<WorkflowDefinition["edges"]>[number];

/** An edge with valid ends: from a step or a signal trigger, to a step. */
export interface GraphEdge {
  readonly index: number;
  readonly from: string;
  readonly to: string;
  /** Whether the edge has `maxTraversals`, which limits how often a run can go round a loop through it. */
  readonly capped: boolean;
}

/** The ids of the steps and triggers, which are the nodes an edge may refer to. */
export interface GraphNodes {
  readonly stepIds: ReadonlySet<string>;
  readonly signalIds: ReadonlySet<string>;
  readonly startIds: ReadonlySet<string>;
}

const START_TRIGGER_HAS_NO_EDGES =
  "A start trigger starts runs, and does not continue one, so it cannot have edges. " +
  "Remove the edge: a run starts at its entry steps.";

/** Returns an issue for each end of an edge that is not a valid node for that end. */
export const listEdgeEndIssues = (
  edge: Edge,
  index: number,
  nodes: GraphNodes,
): ReadonlyArray<Issue> => {
  const path = ["edges", String(index)];
  const issues: Array<Issue> = [];
  if (nodes.startIds.has(edge.from)) {
    issues.push({
      path: [...path, "from"],
      message: `${quoteAuthorText(edge.from)} is a start trigger. ${START_TRIGGER_HAS_NO_EDGES}`,
    });
  } else if (!nodes.stepIds.has(edge.from) && !nodes.signalIds.has(edge.from)) {
    issues.push({
      path: [...path, "from"],
      message: `No step or signal trigger has the id ${quoteAuthorText(edge.from)}. An edge starts at a step or at a signal trigger. Write the id of one.`,
    });
  }
  if (nodes.startIds.has(edge.to)) {
    issues.push({
      path: [...path, "to"],
      message: `${quoteAuthorText(edge.to)} is a start trigger. ${START_TRIGGER_HAS_NO_EDGES}`,
    });
  } else if (nodes.signalIds.has(edge.to)) {
    issues.push({
      path: [...path, "to"],
      message:
        `${quoteAuthorText(edge.to)} is a signal trigger. A signal trigger fires when its event reaches the run, ` +
        "so no edge can lead into it. Lead the edge into a step.",
    });
  } else if (!nodes.stepIds.has(edge.to)) {
    issues.push({
      path: [...path, "to"],
      message: `No step has the id ${quoteAuthorText(edge.to)}. An edge leads into a step. Write the id of one.`,
    });
  }
  return issues;
};

/** Returns the successors of each node, by node id. A node with no outgoing edge has no entry. */
const buildSuccessorMap = (
  edges: ReadonlyArray<GraphEdge>,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const successors = new Map<string, Array<string>>();
  for (const edge of edges) {
    const known = successors.get(edge.from);
    if (known === undefined) successors.set(edge.from, [edge.to]);
    else known.push(edge.to);
  }
  return successors;
};

/**
 * Returns the node sets of the loops in a graph: each strongly connected
 * component that contains a loop, which means it has more than one node, or
 * one node with an edge to itself.
 *
 * Uses Tarjan's algorithm with an explicit stack instead of recursion, so a
 * large graph cannot overflow the call stack.
 */
const findLoops = (
  nodeIds: ReadonlyArray<string>,
  edges: ReadonlyArray<GraphEdge>,
): ReadonlyArray<ReadonlySet<string>> => {
  const successors = buildSuccessorMap(edges);
  const order = new Map<string, number>();
  const lowest = new Map<string, number>();
  const stack: Array<string> = [];
  const onStack = new Set<string>();
  const loops: Array<ReadonlySet<string>> = [];
  const enter = (id: string): void => {
    order.set(id, order.size);
    lowest.set(id, order.get(id)!);
    stack.push(id);
    onStack.add(id);
  };
  for (const root of nodeIds) {
    if (order.has(root)) continue;
    enter(root);
    const walk: Array<{ readonly id: string; next: number }> = [{ id: root, next: 0 }];
    while (walk.length > 0) {
      const frame = walk.at(-1)!;
      const next = successors.get(frame.id)?.[frame.next];
      if (next !== undefined) {
        frame.next += 1;
        if (!order.has(next)) {
          enter(next);
          walk.push({ id: next, next: 0 });
        } else if (onStack.has(next)) {
          lowest.set(frame.id, Math.min(lowest.get(frame.id)!, order.get(next)!));
        }
        continue;
      }
      walk.pop();
      const parent = walk.at(-1);
      if (parent !== undefined) {
        lowest.set(parent.id, Math.min(lowest.get(parent.id)!, lowest.get(frame.id)!));
      }
      if (lowest.get(frame.id) !== order.get(frame.id)) continue;
      const component = new Set<string>();
      for (let member = stack.pop()!; ; member = stack.pop()!) {
        onStack.delete(member);
        component.add(member);
        if (member === frame.id) break;
      }
      if (component.size > 1 || (successors.get(frame.id) ?? []).includes(frame.id)) {
        loops.push(component);
      }
    }
  }
  return loops;
};

/**
 * Checks the rules about the graph as a whole (see the top of this file).
 * `edges` holds only the edges with valid ends. Returns every issue found.
 */
export const listGraphIssues = (
  definition: WorkflowDefinition,
  edges: ReadonlyArray<GraphEdge>,
  nodes: GraphNodes,
): ReadonlyArray<Issue> => {
  const { steps } = definition;
  const issues: Array<Issue> = [];
  const stepIds = steps.map((step) => step.id);
  const nodeIds = [...nodes.signalIds, ...stepIds];
  const sortInStepOrder = (loop: ReadonlySet<string>): ReadonlyArray<string> =>
    stepIds.filter((id) => loop.has(id));

  // A run counts how often it follows each edge, and a second edge between
  // the same two nodes would make "the edge from A to B" mean two things.
  // Report each repeat at the later edge.
  const seenEdgeEndpoints = new Set<string>();
  for (const edge of edges) {
    const edgeEndpoints = JSON.stringify([edge.from, edge.to]);
    if (seenEdgeEndpoints.has(edgeEndpoints)) {
      issues.push({
        path: ["edges", String(edge.index)],
        message:
          `An earlier edge already leads from ${quoteAuthorText(edge.from)} to ${quoteAuthorText(edge.to)}, ` +
          "and two edges cannot connect the same two nodes. " +
          "Remove this edge, or combine the two conditions into one with ||.",
      });
    }
    seenEdgeEndpoints.add(edgeEndpoints);
  }

  // Find the loops that remain after removing every edge with maxTraversals.
  // Report each one at its first edge in definition order.
  for (const loop of findLoops(
    nodeIds,
    edges.filter((edge) => !edge.capped),
  )) {
    const first = edges.find((edge) => !edge.capped && loop.has(edge.from) && loop.has(edge.to))!;
    const names = joinNames(sortInStepOrder(loop).map(quoteAuthorText));
    issues.push({
      path: ["edges", String(first.index)],
      message:
        `${loop.size === 1 ? `The step ${names} leads into itself` : `The steps ${names} form a loop`}, ` +
        "and no edge of the loop has maxTraversals, so a run could go round the loop without end. " +
        "Add maxTraversals to one edge of the loop.",
    });
  }

  // `join: all` waits for every incoming edge, but the edge that comes back
  // round a loop cannot fire before the step has run once.
  const inLoop = new Set(findLoops(nodeIds, edges).flatMap((loop) => [...loop]));
  for (const [index, step] of steps.entries()) {
    if (step.join === "all" && inLoop.has(step.id)) {
      issues.push({
        path: ["steps", String(index), "join"],
        message:
          "This step is inside a loop, so join: all can never run it: the edge that comes back round the loop " +
          "cannot fire before this step runs. Write join: any, or remove join.",
      });
    }
  }

  // An entry step starts when the run starts, before any incoming edge could
  // fire, so it could never wait for all of them.
  for (const [index, step] of steps.entries()) {
    if (step.entry === true && step.join === "all") {
      issues.push({
        path: ["steps", String(index), "join"],
        message:
          "This step is an entry step, so it starts when a run starts and cannot wait for its incoming edges first. " +
          "Remove join: all, or remove entry: true.",
      });
    }
  }

  const entryIds = listEntrySteps(definition).map((step) => step.id);
  if (steps.length > 0 && entryIds.length === 0) {
    // Every step has an incoming edge, which usually means the run was meant
    // to begin inside a loop. So report the error at the first step that
    // another step leads into.
    const ledIntoByStep = new Set(
      edges.filter((edge) => nodes.stepIds.has(edge.from)).map((edge) => edge.to),
    );
    const index = Math.max(
      steps.findIndex((step) => ledIntoByStep.has(step.id)),
      0,
    );
    issues.push({
      path: ["steps", String(index)],
      message:
        "No step begins a run of this workflow: an edge leads into every step, so no step starts when a run starts. " +
        "Write entry: true on this step, or on the step where a run begins.",
    });
    // Without an entry step, no step can be reached. That is the same
    // problem, so do not also report every step as unreachable.
    return issues;
  }

  const successors = buildSuccessorMap(edges);
  const reached = new Set<string>([...entryIds, ...nodes.signalIds]);
  // A Set iterator also visits values added during the iteration, so this
  // loop is a breadth-first search.
  for (const id of reached) {
    for (const next of successors.get(id) ?? []) reached.add(next);
  }
  for (const [index, step] of steps.entries()) {
    if (!reached.has(step.id)) {
      issues.push({
        path: ["steps", String(index)],
        message:
          "No path leads to this step from an entry step or from a signal trigger, so a run never runs it. " +
          "Add an edge that leads into it, or write entry: true on it if a run begins here.",
      });
    }
  }
  return issues;
};
