/**
 * The graph of a workflow's definition: the nodes that an edge may join, and
 * the rules about the graph as a whole. A loop has an edge with
 * `maxTraversals`, a step inside a loop does not join with `all`, a run has a
 * step to begin at, and each step is reached from where a run begins.
 *
 * The rules about the whole graph read every edge together, and the other
 * checks of a workflow read one place at a time. So the graph has a module of
 * its own, and the checks in `./validation` call it.
 */
import {
  joinNames,
  listEntrySteps,
  quoteWritten,
  type Issue,
  type WorkflowDefinition,
} from "@hercule/contract";

type Edge = NonNullable<WorkflowDefinition["edges"]>[number];

/** An edge whose two ends name nodes it may join: a step or a signal trigger, to a step. */
export interface GraphEdge {
  readonly index: number;
  readonly from: string;
  readonly to: string;
  /** Whether the edge carries `maxTraversals`, which bounds how often a loop through it runs. */
  readonly capped: boolean;
}

/** The ids of the steps and of the triggers: what an edge may name. */
export interface GraphNodes {
  readonly stepIds: ReadonlySet<string>;
  readonly signalIds: ReadonlySet<string>;
  readonly startIds: ReadonlySet<string>;
}

/** Why a start trigger cannot be an end of an edge. */
const START_TRIGGER_HAS_NO_EDGES =
  "A start trigger starts runs, and does not continue one, so it cannot have edges. " +
  "Remove the edge: a run starts at its entry steps.";

/** Each end of an edge that names no node it may join. */
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
      message: `${quoteWritten(edge.from)} is a start trigger. ${START_TRIGGER_HAS_NO_EDGES}`,
    });
  } else if (!nodes.stepIds.has(edge.from) && !nodes.signalIds.has(edge.from)) {
    issues.push({
      path: [...path, "from"],
      message: `No step or signal trigger has the id ${quoteWritten(edge.from)}. An edge starts at a step or at a signal trigger. Write the id of one.`,
    });
  }
  if (nodes.startIds.has(edge.to)) {
    issues.push({
      path: [...path, "to"],
      message: `${quoteWritten(edge.to)} is a start trigger. ${START_TRIGGER_HAS_NO_EDGES}`,
    });
  } else if (nodes.signalIds.has(edge.to)) {
    issues.push({
      path: [...path, "to"],
      message:
        `${quoteWritten(edge.to)} is a signal trigger. A signal trigger fires when its event reaches the run, ` +
        "so no edge can lead into it. Lead the edge into a step.",
    });
  } else if (!nodes.stepIds.has(edge.to)) {
    issues.push({
      path: [...path, "to"],
      message: `No step has the id ${quoteWritten(edge.to)}. An edge leads into a step. Write the id of one.`,
    });
  }
  return issues;
};

/** The nodes each node's edges lead to, by node. A node with no edge out is not in it. */
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
 * The sets of nodes that loops go through: each strongly connected component
 * that holds a loop, which is one of more than one node, or one node with an
 * edge to itself. Tarjan's algorithm, with a stack of its own in place of
 * recursion, so a large graph cannot exhaust the call stack.
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
 * The rules about the graph as a whole, over the edges whose ends are valid:
 * a loop has an edge with `maxTraversals`, a step inside a loop does not join
 * with `all`, a run has a step to begin at, and each step is reached from
 * where a run begins.
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

  // A loop of edges that carry no maxTraversals, when every edge that carries
  // one is taken away. It is named at its first edge in definition order.
  for (const loop of findLoops(
    nodeIds,
    edges.filter((edge) => !edge.capped),
  )) {
    const first = edges.find((edge) => !edge.capped && loop.has(edge.from) && loop.has(edge.to))!;
    const names = joinNames(sortInStepOrder(loop).map(quoteWritten));
    issues.push({
      path: ["edges", String(first.index)],
      message:
        `${loop.size === 1 ? `The step ${names} leads into itself` : `The steps ${names} form a loop`}, ` +
        "and no edge of the loop has maxTraversals, so a run could go round the loop without end. " +
        "Add maxTraversals to one edge of the loop.",
    });
  }

  // `all` waits for every incoming edge, and the edge that comes back round a
  // loop cannot fire before the step runs the first time.
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

  // A run begins at every entry step.
  const entryIds = listEntrySteps(definition).map((step) => step.id);
  if (steps.length > 0 && entryIds.length === 0) {
    // The run most likely begins in the loop that leaves every step with an
    // edge into it, so the refusal is placed at a step another step leads into.
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
    // Without an entry step every step is unreached, and that is this one
    // problem, which is named once.
    return issues;
  }

  const successors = buildSuccessorMap(edges);
  const reached = new Set<string>([...entryIds, ...nodes.signalIds]);
  // The set grows while it is walked, and a walk of a set visits what is added
  // behind the walk too, so this is a breadth-first search.
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
