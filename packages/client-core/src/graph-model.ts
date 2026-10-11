/**
 * The workflow graph's model: the cards and edges the graph draws for a
 * workflow definition, before they are laid out (spec 17 §Workflows, "The
 * open workflow"). It builds on `buildIndexedWorkflowGraph`, which lists the
 * nodes and edges, and adds what a card and an edge's label show.
 *
 * The drawing holds no run. A run's page draws one on top of it with
 * `buildRunOverlay`: every node and edge has an id that stays the same for
 * every run of the definition, so the run's state is looked up by id.
 *
 * This module is the subpath `@hercule/client-core/graph-model`, not part of
 * the index, so that it stays off the desktop app's first screen.
 */
import {
  isSchedule,
  type Agent,
  type Run,
  type Session,
  type TriggerFiresOn,
  type WorkflowAction,
  type WorkflowDefinition,
} from "@hercule/contract";
import { parsePluginId } from "./plugin-id";
import { isRunLive, listAwaitedSignals, type WorkState } from "./run-display";
import { buildRunGraph, type EdgeTravel } from "./run-graph";
import { describeSchedule } from "./schedule-text";
import { decideFiresOn } from "./trigger-display";
import {
  abbreviateEdgeCondition,
  buildIndexedWorkflowGraph,
  shortenCondition,
  type IndexedWorkflowGraphEdge,
  type NodeKind,
} from "./workflow-graph";

// The node kind is declared beside the graph `buildIndexedWorkflowGraph`
// lists, which this module builds on, and exported here for the screens.
export type { NodeKind } from "./workflow-graph";

/** A trigger or a step, as a card on the graph. */
export interface GraphNode {
  /** The trigger's or step's id, which is the card's title. */
  readonly id: string;
  readonly kind: NodeKind;
  /**
   * The line under the title: the name of the Agent an agent step runs as,
   * the name of the action an action step calls, or what a trigger fires on,
   * with a schedule in words.
   */
  readonly detail: string;
  /**
   * Whether a trigger fires on a schedule or on events, which draws a clock
   * or a bolt. Null for a step.
   */
  readonly firesOn: TriggerFiresOn | null;
  /**
   * The id of the plugin whose action an action step calls, whose mark the
   * step draws: `github` for `github/pr.create`. Null for a built-in action,
   * which draws an app icon, and for every node that is not an action step.
   */
  readonly pluginId: string | null;
  /** Whether the step waits for every edge into it before it starts, which draws the tag "all". */
  readonly joinsAll: boolean;
  /** Whether the run ends when the step completes. */
  readonly terminal: boolean;
}

/**
 * An edge on the graph:
 *
 * - `plan`: an edge of the definition, one from a start trigger to an entry
 *   step, or one into or out of the start triggers' junction;
 * - `correlation`: from the step whose output a signal trigger correlates
 *   on, to that signal. A run follows no such edge: the run listens for the
 *   signal once the step has given the value, so the edge is drawn dashed.
 */
export interface GraphEdge {
  /**
   * A key that is unique within the graph and the same for every run of the
   * definition. An edge of the definition's `edges` is `plan <index>`, by its
   * index there, which is the index a run counts its traversals by.
   */
  readonly id: string;
  readonly kind: "plan" | "correlation";
  readonly from: string;
  readonly to: string;
  /** The edge's condition, shortened to fit its label, or `undefined` for none. */
  readonly condition: string | undefined;
  /** The condition as written, for the label's tooltip. */
  readonly fullCondition: string | undefined;
  /** `≤ 3` for an edge a run may follow at most three times, or `undefined` for no limit. */
  readonly limit: string | undefined;
  /**
   * How often a run may follow the edge, or `undefined` for no limit. Every
   * loop in a valid workflow has an edge with a limit, and that edge is the
   * one that goes back to the start of the loop, which the layout uses.
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
const BUS_ID = "start bus";

/** Returns the ids of the steps a correlation expression reads the output of, such as `open_pr` in `steps.open_pr.output.number`. */
const listCorrelatedSteps = (expression: string): ReadonlyArray<string> => [
  ...new Set(
    [...expression.matchAll(/(?<![\w.])steps\.(\w+)\.output\b/g)].map((match) => match[1]!),
  ),
];

/** Returns the id of the edge from a start trigger to an entry step, when the two connect directly. */
const buildStartEdgeId = (from: string, to: string): string => `start ${from} ${to}`;

/** Returns the id of the edge at `planEdgeIndex` in the definition's `edges`. */
const buildPlanEdgeId = (planEdgeIndex: number): string => `plan ${String(planEdgeIndex)}`;

/** Builds an edge with no condition and no limit, such as one into or out of the junction. */
const buildPlainEdge = (id: string, from: string, to: string): GraphEdge => ({
  id,
  kind: "plan",
  from,
  to,
  condition: undefined,
  fullCondition: undefined,
  limit: undefined,
  maxTraversals: undefined,
});

/**
 * Builds what the graph draws for `definition`. `agents` and `actions` name what
 * each step runs; a step whose Agent or action is not among them shows its
 * id instead.
 *
 * The edges are listed in this order: the start triggers' edges, then the
 * definition's own edges in its order, then the correlation edges. When two
 * or more start triggers lead to two or more entry steps, the start
 * triggers' edges go through a junction, whose id is the drawing's `busId`.
 */
export const buildGraphDrawing = (
  definition: WorkflowDefinition,
  agents: ReadonlyArray<Pick<Agent, "id" | "name">>,
  actions: ReadonlyArray<Pick<WorkflowAction, "id" | "displayName">>,
): WorkflowGraphDrawing => {
  const indexed = buildIndexedWorkflowGraph(definition);
  const triggers = new Map((definition.triggers ?? []).map((trigger) => [trigger.id, trigger]));
  const steps = new Map(definition.steps.map((step) => [step.id, step]));

  const nodes = indexed.nodes.map((node): GraphNode => {
    const on = triggers.get(node.id)?.on;
    const step = steps.get(node.id);
    const detail =
      on !== undefined
        ? isSchedule(on)
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
      firesOn: on === undefined ? null : decideFiresOn(on),
      pluginId: step?.kind === "action" ? parsePluginId(step.action) : null,
      joinsAll: step?.join === "all",
      terminal: node.terminal === true,
    };
  });

  const startEdges = indexed.edges.filter(({ planEdgeIndex }) => planEdgeIndex === undefined);
  const startTriggerIds = [...new Set(startEdges.map(({ edge }) => edge.from))];
  const entryStepIds = [...new Set(startEdges.map(({ edge }) => edge.to))];
  const usesBus = startTriggerIds.length > 1 && entryStepIds.length > 1;
  const startGraphEdges = usesBus
    ? [
        ...startTriggerIds.map((from) => buildPlainEdge(`bus in ${from}`, from, BUS_ID)),
        ...entryStepIds.map((to) => buildPlainEdge(`bus out ${to}`, BUS_ID, to)),
      ]
    : startEdges.map(({ edge }) =>
        buildPlainEdge(buildStartEdgeId(edge.from, edge.to), edge.from, edge.to),
      );

  const buildPlanEdge = (
    edge: IndexedWorkflowGraphEdge["edge"],
    planEdgeIndex: number,
  ): GraphEdge => {
    const abbreviated = abbreviateEdgeCondition(edge);
    return {
      id: buildPlanEdgeId(planEdgeIndex),
      kind: "plan",
      from: edge.from,
      to: edge.to,
      condition: abbreviated === undefined ? undefined : shortenCondition(abbreviated),
      fullCondition: edge.condition,
      limit: edge.maxTraversals === undefined ? undefined : `≤ ${String(edge.maxTraversals)}`,
      maxTraversals: edge.maxTraversals,
    };
  };
  const planEdges = indexed.edges.flatMap(({ edge, planEdgeIndex }) =>
    planEdgeIndex === undefined ? [] : [buildPlanEdge(edge, planEdgeIndex)],
  );

  const correlationEdges = (definition.triggers ?? []).flatMap((trigger) =>
    trigger.kind === "signal"
      ? listCorrelatedSteps(trigger.correlation.run)
          .filter((stepId) => steps.has(stepId))
          .map((stepId): GraphEdge => ({
            id: `correlation ${stepId} ${trigger.id}`,
            kind: "correlation",
            from: stepId,
            to: trigger.id,
            condition: shortenCondition(
              trigger.correlation.run.replace(`steps.${stepId}.output.`, ""),
            ),
            fullCondition: `${trigger.correlation.event} == ${trigger.correlation.run}`,
            limit: undefined,
            maxTraversals: undefined,
          }))
      : [],
  );

  return {
    nodes,
    edges: [...startGraphEdges, ...planEdges, ...correlationEdges],
    busId: usesBus ? BUS_ID : undefined,
  };
};

/**
 * Where a run is at one node of its graph.
 *
 * A step's state follows its current step record (see `buildRunGraph`):
 * `unreached` with none, `working` while it runs, `waiting` while it runs and
 * its session has an open Request, `done` once it completed, and the record's
 * own status otherwise.
 *
 * A trigger has no state of its own, so its state says how the run relates
 * to it:
 *
 * - `fired`: the start trigger that started the run, or a signal that fired;
 * - `listening`: a signal the run waits for now;
 * - `quiet`: a start trigger that did not start the run, or a signal that has
 *   not fired.
 */
export type NodeRunState =
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

/** Where a run is at one node of its graph. */
export interface NodeOnRun {
  readonly state: NodeRunState;
  /** `×2` after the id of a step the run came to twice, or of a signal that fired twice. `undefined` for at most once. */
  readonly iterationLabel: string | undefined;
}

/** How far a run came along one edge of its graph. */
export interface EdgeOnRun {
  readonly travel: EdgeTravel;
  /** Whether the run failed at this edge, on its limit or on its condition. */
  readonly isFailedEdge: boolean;
  /**
   * How often the run followed an edge with a limit, out of that limit, such
   * as `1/3`, which the label shows in place of `≤ 3`. `undefined` for an
   * edge with no limit.
   */
  readonly traversalBadge: string | undefined;
}

/** A run drawn on top of its graph: its state at every node and edge, by their ids. */
export interface RunOverlay {
  /** By `GraphNode.id`. Every node of the drawing has an entry. */
  readonly nodes: ReadonlyMap<string, NodeOnRun>;
  /** By `GraphEdge.id`, including the edges through the junction and the correlation edges. Every edge of the drawing has an entry. */
  readonly edges: ReadonlyMap<string, EdgeOnRun>;
  /**
   * How far the run came along the stub from each terminal step to the end,
   * by the step's id: `fired` once the step is done, `notYet` while the run
   * is live, and `notTaken` once the run ended without the step being done.
   */
  readonly endStubs: ReadonlyMap<string, EdgeTravel>;
}

/**
 * Returns where a step stands, from the `state` of one of its records and
 * whether that record's session waits on the user (`isAsking`). A running
 * record whose session asks is `waiting`; `isAsking` means nothing for a
 * record in any other state.
 */
export const decideStepRunState = (state: WorkState, isAsking: boolean): NodeRunState => {
  switch (state) {
    case "running":
      return isAsking ? "waiting" : "working";
    case "completed":
      return "done";
    case "unreached":
    case "pending":
    case "failed":
    case "cancelled":
    case "skipped":
      return state;
  }
};

/** The order in which an edge through the junction takes the furthest travel of the edges it stands for. */
const TRAVEL_RANK: Readonly<Record<EdgeTravel, number>> = {
  notTaken: 0,
  notYet: 1,
  fired: 2,
  active: 3,
};

/** Returns the furthest travel of `travels`, or `notTaken` for none. */
const findFurthestTravel = (travels: ReadonlyArray<EdgeTravel>): EdgeTravel =>
  travels.reduce<EdgeTravel>(
    (furthest, travel) => (TRAVEL_RANK[travel] > TRAVEL_RANK[furthest] ? travel : furthest),
    "notTaken",
  );

/**
 * Builds `run`'s state at every node and edge of `drawing`, which was built
 * from `run.plan`. `sessions` are the run's sessions: a running step whose
 * session has an open Request is `waiting` (see `NodeRunState`).
 *
 * Each edge of the definition, and each edge from a start trigger, takes the
 * run's reading of it from `buildRunGraph`. An edge into or out of the start
 * triggers' junction stands for several edges from start triggers, and takes
 * the furthest travel among them. A correlation edge is `fired` once its step
 * has completed, because the run then listens for the signal; until then it
 * is `notYet` while the run is live and `notTaken` once it has ended.
 */
export const buildRunOverlay = (
  drawing: WorkflowGraphDrawing,
  run: Run,
  sessions: ReadonlyArray<Session>,
): RunOverlay => {
  const runGraph = buildRunGraph(run);
  const isLive = isRunLive(run.status);
  const askingSessionIds = new Set(
    sessions.filter((session) => session.openRequests.length > 0).map((session) => session.id),
  );
  const askingStepIds = new Set(
    run.steps
      .filter(
        (record) => record.status === "running" && askingSessionIds.has(record.sessionId ?? ""),
      )
      .map((record) => record.stepId),
  );
  const awaitedSignalIds = new Set(listAwaitedSignals(run));
  const startingTriggerId = run.origin.kind === "trigger" ? run.origin.triggerId : undefined;

  const decideNodeState = (node: (typeof runGraph.nodes)[number]): NodeRunState => {
    if (node.progress !== undefined) {
      return decideStepRunState(node.progress.state, askingStepIds.has(node.id));
    }
    if (node.kind === "start") return node.id === startingTriggerId ? "fired" : "quiet";
    if (awaitedSignalIds.has(node.id)) return "listening";
    return node.iterationCount > 0 ? "fired" : "quiet";
  };
  const runNodes = new Map(
    runGraph.nodes.map((node): [string, NodeOnRun] => [
      node.id,
      { state: decideNodeState(node), iterationLabel: node.iterationLabel },
    ]),
  );

  const runEdges = new Map(
    runGraph.edges.map((edge) => [
      edge.planEdgeIndex === undefined
        ? buildStartEdgeId(edge.from, edge.to)
        : buildPlanEdgeId(edge.planEdgeIndex),
      edge,
    ]),
  );
  const startEdges = runGraph.edges.filter((edge) => edge.planEdgeIndex === undefined);
  const hasCompleted = (stepId: string): boolean =>
    run.steps.some((record) => record.stepId === stepId && record.status === "completed");

  const decideEdgeOnRun = (edge: GraphEdge): EdgeOnRun => {
    if (edge.kind === "correlation") {
      const travel = hasCompleted(edge.from) ? "fired" : isLive ? "notYet" : "notTaken";
      return { travel, isFailedEdge: false, traversalBadge: undefined };
    }
    if (edge.from === drawing.busId || edge.to === drawing.busId) {
      // An edge into the junction shares its start trigger with the edges it
      // stands for, and an edge out of it shares its entry step.
      const travel = findFurthestTravel(
        startEdges
          .filter((each) => each.from === edge.from || each.to === edge.to)
          .map((each) => each.travel),
      );
      return { travel, isFailedEdge: false, traversalBadge: undefined };
    }
    const { travel, isFailedEdge, traversalBadge } = runEdges.get(edge.id)!;
    return { travel, isFailedEdge, traversalBadge };
  };

  const nodes = new Map(
    drawing.nodes.map((node): [string, NodeOnRun] => [
      node.id,
      runNodes.get(node.id) ?? { state: "unreached", iterationLabel: undefined },
    ]),
  );
  return {
    nodes,
    edges: new Map(drawing.edges.map((edge) => [edge.id, decideEdgeOnRun(edge)])),
    endStubs: new Map(
      drawing.nodes
        .filter((node) => node.terminal)
        .map((node): [string, EdgeTravel] => [
          node.id,
          nodes.get(node.id)?.state === "done" ? "fired" : isLive ? "notYet" : "notTaken",
        ]),
    ),
  };
};
