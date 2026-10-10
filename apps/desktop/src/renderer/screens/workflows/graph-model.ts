/**
 * PROTOTYPE. Decides what the workflow graph draws, from a workflow's
 * definition and, when one is picked, one of its runs. The Workflows ticket
 * moves it into `@hercule/client-core`, beside `buildRunGraph`, which it
 * builds on.
 */
import {
  abbreviateEdgeCondition,
  buildRunGraph,
  buildWorkflowGraph,
  isRunLive,
  listAwaitedSignals,
  shortenCondition,
  type EdgeTravel,
  type WorkflowGraphEdge,
} from "@hercule/client-core";
import type {
  Agent,
  Run,
  Session,
  StepRecord,
  WorkflowAction,
  WorkflowDefinition,
} from "@hercule/contract";
import type { MarkState } from "../../marks/mark-state";
import { describeSchedule } from "./schedule-text";

/**
 * Where a run is at one node, as the graph draws it. `none` when the graph
 * draws no run.
 *
 * A step's state follows its current step record: `unreached` with none,
 * `working` while it runs, `waiting` while it runs and its session has an open
 * Request, and the record's own status otherwise.
 *
 * A trigger has no step record of its own, so its state says how the run
 * relates to it:
 *
 * - `fired`: the start trigger that started the run, or a signal that fired;
 * - `listening`: a signal the run waits for now;
 * - `quiet`: a start trigger that did not start the run, or a signal that has
 *   not fired.
 */
export type GraphNodeState =
  | "none"
  | "unreached"
  | "pending"
  | "working"
  | "waiting"
  | "done"
  | "failed"
  | "cancelled"
  | "skipped"
  | "fired"
  | "listening"
  | "quiet";

/** The mark each state draws on its card's corner. A state with none draws no mark. */
export const NODE_MARKS: Partial<Record<GraphNodeState, MarkState>> = {
  working: "working",
  waiting: "waiting",
  done: "done",
  failed: "failed",
  fired: "done",
  listening: "idle",
};

/** A trigger or a step, as a card on the graph. */
export interface GraphNode {
  /** The trigger's or step's id, which is the card's title. */
  readonly id: string;
  readonly kind: "start" | "signal" | "action" | "agent";
  /**
   * The line under the title: the Agent an agent step runs as, the action an
   * action step calls, or what a trigger fires on, with a schedule in words.
   */
  readonly detail: string;
  /** Whether a start trigger fires on a schedule, which draws a clock instead of a bolt. */
  readonly firesOnSchedule: boolean;
  readonly state: GraphNodeState;
  /** `×3` for a step the run came to three times. */
  readonly iterationLabel: string | undefined;
  /** Whether the step waits for every edge into it before it starts. */
  readonly joinsAll: boolean;
  /** Whether the run ends when the step completes. */
  readonly terminal: boolean;
}

/**
 * An edge on the graph:
 *
 * - `plan`: an edge of the definition, or one from a start trigger to an
 *   entry step;
 * - `correlation`: from the step whose output a signal trigger correlates
 *   on, to that signal. A run follows no such edge: the run listens for the
 *   signal once the step has given the value, so the edge is drawn dashed.
 */
export interface GraphEdge {
  /** A key that is unique within the graph and stays the same from run to run. */
  readonly id: string;
  readonly kind: "plan" | "correlation";
  readonly from: string;
  readonly to: string;
  /** How far the run came along the edge, or `undefined` when the graph draws no run. */
  readonly travel: EdgeTravel | undefined;
  /** The edge's condition, shortened to fit its label. */
  readonly condition: string | undefined;
  /** The condition as written, for the label's tooltip. */
  readonly fullCondition: string | undefined;
  /** `≤ 3` for an edge with a limit, or how often the run followed it, `1/3`. */
  readonly limit: string | undefined;
  readonly isFailedEdge: boolean;
  /**
   * How often a run may follow the edge, or `undefined` for no limit. Every
   * loop in a valid workflow has an edge with a limit, and that edge is the
   * one that goes back to the start of the loop.
   */
  readonly maxTraversals: number | undefined;
}

/** A workflow's graph, ready to lay out and draw. */
export interface WorkflowGraphDrawing {
  readonly nodes: ReadonlyArray<GraphNode>;
  readonly edges: ReadonlyArray<GraphEdge>;
  /**
   * The id of the junction the start triggers fan out through, or
   * `undefined` when they connect to the entry steps directly. With two start
   * triggers and four entry steps, eight crossing edges become six that meet
   * at one point.
   */
  readonly busId: string | undefined;
}

/** The id of the start triggers' junction. No trigger or step id has a space, so it never collides. */
export const BUS_ID = "start bus";

/** The order in which edges through the junction take the furthest travel of the edges they stand for. */
const TRAVEL_RANK: Readonly<Record<EdgeTravel, number>> = {
  notTaken: 0,
  notYet: 1,
  fired: 2,
  active: 3,
};

/** Returns the furthest travel of `travels`, or `undefined` for none. */
const findFurthestTravel = (
  travels: ReadonlyArray<EdgeTravel | undefined>,
): EdgeTravel | undefined =>
  travels.reduce<EdgeTravel | undefined>(
    (furthest, travel) =>
      travel !== undefined &&
      (furthest === undefined || TRAVEL_RANK[travel] > TRAVEL_RANK[furthest])
        ? travel
        : furthest,
    undefined,
  );

/** Returns the ids of the steps a correlation expression reads the output of, such as `open_pr` in `steps.open_pr.output.number`. */
const listCorrelatedSteps = (expression: string): ReadonlyArray<string> => [
  ...new Set(
    [...expression.matchAll(/(?<![\w.])steps\.(\w+)\.output\b/g)].map((match) => match[1]!),
  ),
];

/** Returns the ids of the steps whose running record drives a session with an open Request. */
const listAskingSteps = (
  steps: ReadonlyArray<StepRecord>,
  sessions: ReadonlyArray<Session>,
): ReadonlySet<string> => {
  const asking = new Set(
    sessions.filter((session) => session.openRequests.length > 0).map((session) => session.id),
  );
  return new Set(
    steps
      .filter((record) => record.status === "running" && asking.has(record.sessionId ?? ""))
      .map((record) => record.stepId),
  );
};

/**
 * Builds what the graph draws for `definition`, with `run`'s progress on it
 * when a run is given. `sessions` are the run's sessions: a running agent step
 * whose session has an open Request is drawn as waiting on the user. `agents`
 * and `actions` name what each step runs.
 */
export const buildGraphDrawing = (
  definition: WorkflowDefinition,
  run: Run | undefined,
  sessions: ReadonlyArray<Session>,
  agents: ReadonlyArray<Agent>,
  actions: ReadonlyArray<WorkflowAction>,
): WorkflowGraphDrawing => {
  const graph = run === undefined ? undefined : buildRunGraph(run);
  const plain = buildWorkflowGraph(definition);
  const triggers = new Map((definition.triggers ?? []).map((trigger) => [trigger.id, trigger]));
  const steps = new Map(definition.steps.map((step) => [step.id, step]));
  const asking = run === undefined ? new Set<string>() : listAskingSteps(run.steps, sessions);
  const awaited = new Set(run === undefined ? [] : listAwaitedSignals(run));
  const startingTriggerId = run?.origin.kind === "trigger" ? run.origin.triggerId : undefined;

  const runNodes = new Map(graph?.nodes.map((node) => [node.id, node]));
  const decideState = (id: string): GraphNodeState => {
    const node = runNodes.get(id);
    if (node === undefined) return "none";
    if (node.kind === "start") return id === startingTriggerId ? "fired" : "quiet";
    if (node.kind === "signal")
      return awaited.has(id) ? "listening" : node.iterationCount > 0 ? "fired" : "quiet";
    switch (node.progress!.state) {
      case "running":
        return asking.has(id) ? "waiting" : "working";
      case "completed":
        return "done";
      default:
        return node.progress!.state;
    }
  };

  const nodes = plain.nodes.map((node): GraphNode => {
    const trigger = triggers.get(node.id);
    const step = steps.get(node.id);
    const on = trigger?.on;
    const firesOnSchedule = on !== undefined && "schedule" in on;
    const detail =
      on !== undefined
        ? "schedule" in on
          ? describeSchedule(on)
          : on.kind
        : step?.kind === "agent"
          ? (agents.find((agent) => agent.id === step.agent)?.name ?? step.agent)
          : step?.kind === "action"
            ? (actions.find((action) => action.id === step.action)?.displayName ?? step.action)
            : "";
    return {
      id: node.id,
      kind: node.kind,
      detail,
      firesOnSchedule,
      state: decideState(node.id),
      iterationLabel: runNodes.get(node.id)?.iterationLabel,
      joinsAll: step?.join === "all",
      terminal: node.terminal === true,
    };
  });

  // The run's graph lists the same edges as the plain graph, in the same
  // order, with the run's travel on each.
  const buildPlanEdge = (edge: WorkflowGraphEdge, index: number): GraphEdge => {
    const travelled = graph?.edges[index];
    const abbreviated = abbreviateEdgeCondition(edge);
    return {
      id: `edge ${String(index)}`,
      kind: "plan",
      from: edge.from,
      to: edge.to,
      travel: travelled?.travel,
      condition: abbreviated === undefined ? undefined : shortenCondition(abbreviated),
      fullCondition: edge.condition,
      limit:
        edge.maxTraversals === undefined
          ? undefined
          : (travelled?.traversalBadge ?? `≤ ${String(edge.maxTraversals)}`),
      isFailedEdge: travelled?.isFailedEdge ?? false,
      maxTraversals: edge.maxTraversals,
    };
  };
  const planEdges = plain.edges.map(buildPlanEdge);
  const isStartEdge = (edge: GraphEdge): boolean => triggers.get(edge.from)?.kind === "start";
  const startEdges = planEdges.filter(isStartEdge);
  const startTriggerIds = [...new Set(startEdges.map((edge) => edge.from))];
  const entryStepIds = [...new Set(startEdges.map((edge) => edge.to))];
  const usesBus = startTriggerIds.length > 1 && entryStepIds.length > 1;
  const busEdges = usesBus
    ? [
        ...startTriggerIds.map((from) =>
          buildBusEdge(
            `bus in ${from}`,
            from,
            BUS_ID,
            startEdges.filter((edge) => edge.from === from),
          ),
        ),
        ...entryStepIds.map((to) =>
          buildBusEdge(
            `bus out ${to}`,
            BUS_ID,
            to,
            startEdges.filter((edge) => edge.to === to),
          ),
        ),
      ]
    : startEdges;

  // A run listens for a signal once the step it correlates on has given its output.
  const decideCorrelationTravel = (stepId: string): EdgeTravel | undefined => {
    if (run === undefined) return undefined;
    const hasOutput = run.steps.some(
      (record) => record.stepId === stepId && record.status === "completed",
    );
    return hasOutput ? "fired" : isRunLive(run.status) ? "notYet" : "notTaken";
  };
  const correlationEdges = (definition.triggers ?? []).flatMap((trigger) =>
    trigger.kind === "signal"
      ? listCorrelatedSteps(trigger.correlation.run)
          .filter((stepId) => steps.has(stepId))
          .map((stepId): GraphEdge => ({
            id: `correlation ${stepId} ${trigger.id}`,
            kind: "correlation",
            from: stepId,
            to: trigger.id,
            travel: decideCorrelationTravel(stepId),
            condition: shortenCondition(
              trigger.correlation.run.replace(`steps.${stepId}.output.`, ""),
            ),
            fullCondition: `${trigger.correlation.event} == ${trigger.correlation.run}`,
            limit: undefined,
            isFailedEdge: false,
            maxTraversals: undefined,
          }))
      : [],
  );

  return {
    nodes,
    edges: [...busEdges, ...planEdges.filter((edge) => !isStartEdge(edge)), ...correlationEdges],
    busId: usesBus ? BUS_ID : undefined,
  };
};

/** Builds an edge into or out of the start triggers' junction, which stands for `edges`. */
const buildBusEdge = (
  id: string,
  from: string,
  to: string,
  edges: ReadonlyArray<GraphEdge>,
): GraphEdge => ({
  id,
  kind: "plan",
  from,
  to,
  travel: findFurthestTravel(edges.map((edge) => edge.travel)),
  condition: undefined,
  fullCondition: undefined,
  limit: undefined,
  isFailedEdge: false,
  maxTraversals: undefined,
});
