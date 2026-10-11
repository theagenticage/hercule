/**
 * The workflow graph's model: the cards and edges the graph draws for a
 * workflow definition, before they are laid out (spec 17 §Workflows, "The
 * open workflow"). It builds on `buildIndexedWorkflowGraph`, which lists the
 * nodes and edges, and adds what a card and an edge's label show.
 *
 * The model draws no run. A run's page draws one on top of it: every node
 * and edge has an id that stays the same for every run of the definition, so
 * the run's state can be added to each by id.
 *
 * This module is the subpath `@hercule/client-core/graph-model`, not part of
 * the index, so that it stays off the desktop app's first screen.
 */
import {
  isSchedule,
  type Agent,
  type TriggerFiresOn,
  type WorkflowAction,
  type WorkflowDefinition,
} from "@hercule/contract";
import { parsePluginId } from "./plugin-id";
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
        buildPlainEdge(`start ${edge.from} ${edge.to}`, edge.from, edge.to),
      );

  const buildPlanEdge = ({ edge, planEdgeIndex }: IndexedWorkflowGraphEdge): GraphEdge => {
    const abbreviated = abbreviateEdgeCondition(edge);
    return {
      id: `plan ${String(planEdgeIndex)}`,
      kind: "plan",
      from: edge.from,
      to: edge.to,
      condition: abbreviated === undefined ? undefined : shortenCondition(abbreviated),
      fullCondition: edge.condition,
      limit: edge.maxTraversals === undefined ? undefined : `≤ ${String(edge.maxTraversals)}`,
      maxTraversals: edge.maxTraversals,
    };
  };
  const planEdges = indexed.edges
    .filter(({ planEdgeIndex }) => planEdgeIndex !== undefined)
    .map(buildPlanEdge);

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
