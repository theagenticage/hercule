/**
 * A run's plan drawn as the workflow graph, with the run's progress on it:
 * - a step card holds its state mark in its leading slot and its duration at
 *   its end, ticking while the step runs;
 * - a step the run has not reached is a dashed, flat card;
 * - an edge the run went along is solid, one it has not is dashed, and the
 *   dashes of the edge into the running step flow toward it.
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
  WORKFLOW_EDGE_STYLE,
  WorkflowNodeCard,
  type EdgeStyle,
} from "../workflow-editor";

/** The leading slot of a step card: the 12px state mark and the gap after it. */
const MARK_SLOT = 12 + 9;
/** The trailing slot of a step card: the gap and its duration, `12.3s` at `text-fine`. */
const DURATION_SLOT = 8 + 46;

/** The style of each kind of edge, by how far the run has come along it. */
const RUN_EDGE_STYLES: Readonly<Record<EdgeTravel, EdgeStyle>> = {
  // An edge the run has not gone along is the workflow's own edge, dashed.
  untravelled: { ...WORKFLOW_EDGE_STYLE, dashArray: "3 4" },
  // The muted colour pulled toward the ink, so the path the run took reads
  // before the paths it did not take.
  travelled: { colour: "color-mix(in oklch, var(--muted), var(--ink) 30%)", width: 1.4 },
  // The live hue, as on every live thing. The class in the shared stylesheet
  // dashes the curve and moves the dashes toward the running step.
  active: { colour: "var(--live)", width: 1.4, className: "hercule-edge-flow" },
};

/** Returns the style of an edge of a run's plan, by how far the run has come along it. */
const decideRunEdgeStyle = (edge: RunGraphEdge): EdgeStyle => RUN_EDGE_STYLES[edge.travel];

/** Returns the width of a step card's mark and duration. A trigger's card has neither. */
const measureRunCardSlots = (node: RunGraphNode): number =>
  node.progress === undefined ? 0 : MARK_SLOT + DURATION_SLOT;

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
 * duration on its card and each edge drawn by how far the run came along it.
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
      />
    </RunMomentContext>
  );
}

/** Renders a node of a run's plan: a step with its progress, or a trigger as the workflow draws it. */
function RunNodeCard({ node }: { readonly node: RunGraphNode }): JSX.Element {
  return node.progress === undefined ? (
    <WorkflowNodeCard node={node} />
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
 * - The running step's border takes the live hue.
 * - The duration sits at the end, ticking while the step runs. A pending
 *   step shows "pending" there instead.
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
        isUnreached
          ? "border-dashed border-[color-mix(in_oklch,var(--faint)_60%,transparent)] bg-surface"
          : "bg-raised shadow-card",
        isUnreached && !isRunLive(run.status) && "opacity-60",
      )}
    >
      <span style={{ width: MARK_SLOT }} className="flex shrink-0 items-center" aria-hidden="true">
        <WorkStateMark state={state} />
      </span>
      {/* The spaces keep the state a word of its own when the card is read as text. */}
      <span className="sr-only"> {describeStepState(state, run.status)} </span>
      <CardText node={node} isFaded={isUnreached} />{" "}
      <span
        aria-hidden="true"
        className={cn(
          "ml-2 w-[46px] shrink-0 text-right text-fine whitespace-nowrap tabular-nums",
          duration !== "" && "font-mono",
          WORK_STATE_HUES[state] ?? "text-faint",
        )}
      >
        {duration !== "" ? duration : state === "pending" ? "pending" : ""}
      </span>
    </div>
  );
}
