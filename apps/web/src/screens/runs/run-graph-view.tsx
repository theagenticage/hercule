/**
 * A run's plan drawn as the workflow graph, with the run's progress on it:
 * - a step card holds its state mark in its leading slot and its duration at
 *   its end, ticking while the step runs, and `×3` after its id when the run
 *   came to it three times;
 * - a signal trigger's card shows `×2` after its id when it fired twice;
 * - a skipped step is a flat card; a step the run has not reached is a
 *   dashed, flat card;
 * - an edge the run went along is solid, and the dashes of an edge into the
 *   running step flow toward it; an edge the run did not follow and never
 *   will is dashed and faded, and one it may still follow is dashed;
 * - a capped edge shows how often the run went along it out of its cap, such
 *   as `2/3`;
 * - the edge the run failed at is drawn in the failure colour.
 */
import { createContext, use, type JSX } from "react";
import {
  describeStepDuration,
  describeStepState,
  isRunLive,
  type EdgeTravel,
  type RunGraph,
  type RunGraphEdge,
  type RunGraphNode,
  type StepProgress,
} from "@hercule/client-core";
import type { RunStatus } from "@hercule/contract";
import { WORK_STATE_HUES, WorkStateMark, cn } from "@hercule/ui";
import {
  CARD_PADDING,
  CardText,
  GraphView,
  LEGIBLE_ZOOM,
  measureMonoText,
  WORKFLOW_EDGE_STYLE,
  WorkflowNodeCard,
  type EdgeBadge,
  type EdgeStyle,
  type PaneSizing,
} from "../workflow-editor";

/** The leading slot of a step card: the 12px state mark and the gap after it. */
const MARK_SLOT = 12 + 9;
/** The trailing slot of a step card: the gap and its duration, `12.3s` at `text-fine`. */
const DURATION_SLOT = 8 + 46;
/** The gap before an iteration count, `gap-1.5`, and its font size, `text-fine`. */
const COUNT_GAP = 6;
const COUNT_FONT_SIZE = 12;

/** The dashes of an edge the run has not followed. */
const UNFIRED_DASHES = "3 4";

/** The style of each kind of edge, by how far the run has come along it. */
const RUN_EDGE_STYLES: Readonly<Record<EdgeTravel, EdgeStyle>> = {
  // The muted colour pulled toward the ink, so the path the run took reads
  // before the paths it did not take.
  fired: { colour: "color-mix(in oklch, var(--muted), var(--ink) 30%)", width: 1.4 },
  // The live hue, as on every live thing. The class in the shared stylesheet
  // dashes the curve and moves the dashes toward the running step.
  active: { colour: "var(--live)", width: 1.4, className: "hercule-edge-flow" },
  // The run will never follow this edge, so it fades behind the edges it
  // may still follow.
  notTaken: { ...WORKFLOW_EDGE_STYLE, dashArray: UNFIRED_DASHES, opacity: 0.5 },
  // The workflow's own edge, dashed.
  notYet: { ...WORKFLOW_EDGE_STYLE, dashArray: UNFIRED_DASHES },
};

/**
 * Returns the style of an edge of a run's plan, by how far the run has come
 * along it. The edge the run failed at takes the failure colour, and stays
 * dashed when the run never went along it, as when its condition could not
 * be evaluated.
 */
const decideRunEdgeStyle = (edge: RunGraphEdge): EdgeStyle => {
  if (!edge.isFailedEdge) return RUN_EDGE_STYLES[edge.travel];
  return {
    colour: "var(--fail)",
    width: 1.4,
    ...(edge.travel === "notTaken" || edge.travel === "notYet"
      ? { dashArray: UNFIRED_DASHES }
      : {}),
  };
};

/**
 * Returns the badge of a capped edge: how often the run went along it out of
 * its cap, in the failure colour on the edge whose cap failed the run.
 */
const describeRunEdgeBadge = (edge: RunGraphEdge): EdgeBadge | undefined =>
  edge.traversalBadge === undefined
    ? undefined
    : { text: edge.traversalBadge, ...(edge.isOverLimit ? { className: "text-fail" } : {}) };

/**
 * Returns the width of what a node's card holds beside its kind label and id:
 * a step card's mark and duration, and the count of how often the run came to
 * the step, or how often a signal trigger fired, when it has one. A start
 * trigger's card holds none of them.
 */
const measureRunCardSlots = (node: RunGraphNode): number => {
  const label = node.iterationLabel;
  const countWidth = label === undefined ? 0 : COUNT_GAP + measureMonoText(label, COUNT_FONT_SIZE);
  return node.progress === undefined ? countWidth : MARK_SLOT + DURATION_SLOT + countWidth;
};

/**
 * How the graph's pane sizes itself. The pane is as tall as the whole plan
 * needs at the zoom that fits the pane's width, so a plan of one row gets a
 * short pane and one that branches or loops a taller one. Past the largest
 * height, the reader pans to see the rest. A plan is never placed below the
 * legible zoom.
 */
const PANE_SIZING: PaneSizing = {
  heightRange: { min: 120, max: 440 },
  smallestPlacedZoom: LEGIBLE_ZOOM,
};

/** A run at the moment it is drawn. */
interface RunMoment {
  /** The run's status. A step the run never reached recedes once the run has ended. */
  readonly status: RunStatus;
  /** The time a running step's duration counts to, in milliseconds since the epoch. */
  readonly now: number;
}

/**
 * The run's moment, for the step cards. It changes on every tick of the
 * clock, while the graph, and so its layout, stays the same until the run
 * changes. Passing the moment through a context re-renders only the cards
 * that read it on a tick, not the whole drawing.
 */
const RunMomentContext = createContext<RunMoment | undefined>(undefined);

/**
 * Renders a run's plan as the workflow graph, with each step's state and
 * duration on its card and each edge drawn by how far the run came along it,
 * in a framed pane as tall as the plan needs.
 */
export function RunGraphView({
  runGraph,
  now,
}: {
  readonly runGraph: RunGraph;
  /** The time a running step's duration counts to, in milliseconds since the epoch. */
  readonly now: number;
}): JSX.Element {
  return (
    <RunMomentContext value={{ status: runGraph.status, now }}>
      <GraphView
        graph={runGraph}
        Card={RunNodeCard}
        measureCardSlots={measureRunCardSlots}
        decideEdgeStyle={decideRunEdgeStyle}
        describeEdgeBadge={describeRunEdgeBadge}
        sizing={PANE_SIZING}
        className="overflow-hidden rounded-card border border-line bg-surface"
      />
    </RunMomentContext>
  );
}

/**
 * Renders a node of a run's plan: a step with its progress, or a trigger as
 * the workflow draws it, with `×2` after a signal trigger's id when it fired
 * twice.
 */
function RunNodeCard({ node }: { readonly node: RunGraphNode }): JSX.Element {
  return node.progress === undefined ? (
    <WorkflowNodeCard node={node} note={node.iterationLabel} />
  ) : (
    <RunStepCard node={node} progress={node.progress} />
  );
}

/**
 * Renders a step of a run, named by its step id. Its state is also written
 * out for a screen reader, because the mark is decorative.
 *
 * - The state mark sits in the leading slot. A step with no step record has
 *   no mark; its card is flat and dashed, and it recedes once the run ended.
 * - A skipped step's card is flat, because the step did no work.
 * - The running step's border takes the live hue.
 * - The iteration count follows the id when the run came to the step more
 *   than once.
 * - The duration sits at the end, ticking while the step runs. A pending or
 *   skipped step shows its state there instead.
 *
 * Fails when it is rendered outside `RunGraphView`, which provides the run's
 * moment.
 */
function RunStepCard({
  node,
  progress,
}: {
  readonly node: RunGraphNode;
  readonly progress: StepProgress;
}): JSX.Element {
  const run = use(RunMomentContext);
  if (run === undefined) throw new Error("A run's step card is rendered only inside RunGraphView.");
  const { state } = progress;
  const isUnreached = state === "unreached";
  const isFlat = isUnreached || state === "skipped";
  const duration = describeStepDuration(progress, run.now);
  return (
    <div
      role="group"
      aria-label={node.id}
      data-state={state}
      style={{
        paddingInline: CARD_PADDING,
        ...(state === "running"
          ? { borderColor: "color-mix(in oklch, var(--live) 60%, var(--line))" }
          : {}),
      }}
      className={cn(
        "flex h-full w-full items-center rounded-card border border-line",
        isFlat ? "bg-surface" : "bg-raised shadow-card",
        isUnreached && "border-dashed border-[color-mix(in_oklch,var(--faint)_60%,transparent)]",
        isUnreached && !isRunLive(run.status) && "opacity-60",
      )}
    >
      <span style={{ width: MARK_SLOT }} className="flex shrink-0 items-center" aria-hidden="true">
        <WorkStateMark state={state} />
      </span>
      {/* The spaces keep the state a word of its own when the card is read as text. */}
      <span className="sr-only"> {describeStepState(state, run.status)} </span>
      <CardText node={node} isFaded={isFlat} note={node.iterationLabel} />{" "}
      <span
        aria-hidden="true"
        className={cn(
          "ml-2 w-[46px] shrink-0 text-right text-fine whitespace-nowrap tabular-nums",
          duration !== "" && "font-mono",
          WORK_STATE_HUES[state] ?? "text-faint",
        )}
      >
        {duration !== "" ? duration : state === "pending" || state === "skipped" ? state : ""}
      </span>
    </div>
  );
}
