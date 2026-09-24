/**
 * A read-only drawing of the workflow graph: a card for each trigger and
 * step, and a curve for each edge with its condition and traversal limit.
 * The layout engine (dagre) positions the cards. React Flow draws them and
 * provides pan, zoom and "Fit to view". This folder is the only place that
 * imports React Flow, so the library can be replaced here alone.
 *
 * The same drawing shows a run's plan. There each step carries its progress
 * and each edge how far the run has come along it, and the drawing shows
 * where the run is:
 * - a step card holds its state mark in its leading slot and its duration at
 *   its end, ticking while the step runs;
 * - a step the run has not reached is a dashed, flat card;
 * - an edge the run went along is solid, one it has not is dashed, and the
 *   dashes of the edge into the running step flow toward it.
 */
import "@xyflow/react/dist/base.css";
import { useEffect, useEffectEvent, useId, useMemo, type JSX } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getViewportForBounds,
  Handle,
  Panel,
  Position,
  ReactFlow,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  abbreviateEdgeCondition,
  describeStepState,
  formatElapsed,
  isRunLive,
  measureElapsed,
  type EdgeTravel,
  type RunGraph,
  type StepProgress,
  type WorkflowGraph,
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
} from "@hercule/client-core";
import type { RunStatus } from "@hercule/contract";
import { Button, WORK_STATE_HUES, WorkStateMark, cn } from "@hercule/ui";
import {
  computeDrawingViewport,
  computeGraphLayout,
  LARGEST_PLACED_ZOOM,
  type EdgeRoute,
  type Point,
  type Size,
} from "./layout";

/**
 * Every glyph of IBM Plex Mono, the font of the ids and edge labels, is 0.6em
 * wide. So a text's width can be computed from its length, and the layout
 * knows the size of every card and label before anything is rendered. Cards
 * and labels are rendered with the same sizes, padding and borders they are
 * measured with, so nothing overlaps a card.
 */
const MONO_GLYPH_WIDTH = 0.6;

/** Returns the width of a text in IBM Plex Mono at a font size. */
const measureMonoText = (text: string, fontSize: number): number =>
  Math.ceil([...text].length * fontSize * MONO_GLYPH_WIDTH);

const CARD_HEIGHT = 52;
/** The width of a card with a short id. It fits every kind label, and an id of 14 characters. */
const MIN_CARD_WIDTH = 136;
/** The font size of a card's id, `text-meta`. */
const ID_FONT_SIZE = 12.5;
/** The space between a card's border and its text. */
const CARD_PADDING = 12;
/** A card's border, `border`. */
const CARD_BORDER = 1;
/**
 * The longest id a card grows to fit. A longer id is truncated, and its
 * tooltip shows the full id.
 */
const MAX_ID_CHARACTERS = 32;
/** The radius of a card's corners, `rounded-card`. */
const CARD_CORNER_RADIUS = 10;
/** The width and the height of an arrowhead. */
const ARROWHEAD_SIZE = 9;
/**
 * The length at each end of a card's side where no edge attaches: the
 * rounded corner plus half an arrowhead. So an arrowhead always lands on the
 * straight part of the side.
 */
const SIDE_MARGIN = CARD_CORNER_RADIUS + ARROWHEAD_SIZE / 2;

/** The leading slot of a step in a run: the 12px state mark and the gap after it. */
const MARK_SLOT = 12 + 9;
/** The trailing slot of a step in a run: the gap and its duration, `12.3s` at `text-fine`. */
const DURATION_SLOT = 8 + 46;

/**
 * A node as this file draws it: a trigger or step of a workflow, or of a
 * run's plan, where a step also carries its progress.
 */
type DrawableNode = WorkflowGraphNode & { readonly progress?: StepProgress | undefined };

/** An edge as this file draws it. In a run's plan it also carries how far the run came along it. */
type DrawableEdge = WorkflowGraphEdge & { readonly travel?: EdgeTravel };

/**
 * Returns the size of a node's card: wide enough for its id, up to
 * `MAX_ID_CHARACTERS`, and in a run's graph for a step's mark and duration.
 */
const measureCard = (node: DrawableNode): Size => ({
  width:
    Math.max(
      MIN_CARD_WIDTH,
      measureMonoText(node.id.slice(0, MAX_ID_CHARACTERS), ID_FONT_SIZE) +
        2 * (CARD_PADDING + CARD_BORDER),
    ) + (node.progress === undefined ? 0 : MARK_SLOT + DURATION_SLOT),
  height: CARD_HEIGHT,
});

/** The font size of an edge label, `text-fine`. */
const LABEL_FONT_SIZE = 12;
const LABEL_HEIGHT = 20;
const LABEL_PADDING = 6;
const LABEL_GAP = 6;
const BADGE_PADDING = 4;
const BADGE_BORDER = 1;
/**
 * The most characters of a condition a label shows. A longer condition shows
 * only its end, after an ellipsis, because two branches from the same step
 * usually differ at the end of their conditions. The tooltip shows the full
 * condition.
 */
const MAX_CONDITION_CHARACTERS = 24;

/**
 * The colour of edges and arrowheads: the faint colour mixed 20% towards the
 * muted colour. This gives lines a 3:1 contrast on the surface in both
 * themes, the minimum for a graphic that carries meaning.
 */
const EDGE_COLOUR = "color-mix(in oklch, var(--faint), var(--muted) 20%)";

/**
 * The colour of an edge a run went along: the muted colour pulled toward the
 * ink, so the path the run took reads before the paths it did not take.
 */
const TRAVELLED_COLOUR = "color-mix(in oklch, var(--muted), var(--ink) 30%)";

/** The colour of the edge into the running step: the live hue, as on every live thing. */
const ACTIVE_COLOUR = "var(--live)";

/** The colour of each kind of edge, and of its arrowhead. */
const EDGE_COLOURS: Readonly<Record<EdgeTravel, string>> = {
  untravelled: EDGE_COLOUR,
  travelled: TRAVELLED_COLOUR,
  active: ACTIVE_COLOUR,
};

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1.5;
/** The padding around the drawing for "Fit to view", as a fraction of the pane. */
const FIT_PADDING = 0.08;

/** The label a card shows for each node kind. */
const KIND_LABELS: Record<WorkflowGraphNode["kind"], string> = {
  start: "Start trigger",
  signal: "Signal trigger",
  action: "Action step",
  agent: "Agent step",
};

/** Returns the badge text for an edge with a traversal limit, or `undefined` for none. */
const formatTraversalBadge = (edge: WorkflowGraphEdge): string | undefined =>
  edge.maxTraversals === undefined ? undefined : `max ${String(edge.maxTraversals)}`;

/** Returns the condition an edge's label shows, truncated at the start when too long. */
const formatConditionLabel = (edge: WorkflowGraphEdge): string | undefined => {
  const condition = abbreviateEdgeCondition(edge);
  if (condition === undefined) return undefined;
  const characters = [...condition];
  return characters.length <= MAX_CONDITION_CHARACTERS
    ? condition
    : `…${characters.slice(1 - MAX_CONDITION_CHARACTERS).join("")}`;
};

/** Returns the size of an edge's label, or `undefined` for an edge with no condition and no limit. */
const measureLabel = (edge: DrawableEdge): Size | undefined => {
  const condition = formatConditionLabel(edge);
  const badge = formatTraversalBadge(edge);
  if (condition === undefined && badge === undefined) return undefined;
  const conditionWidth = condition === undefined ? 0 : measureMonoText(condition, LABEL_FONT_SIZE);
  const badgeWidth =
    badge === undefined
      ? 0
      : measureMonoText(badge, LABEL_FONT_SIZE) + 2 * (BADGE_PADDING + BADGE_BORDER);
  const gap = conditionWidth > 0 && badgeWidth > 0 ? LABEL_GAP : 0;
  return { width: conditionWidth + gap + badgeWidth + 2 * LABEL_PADDING, height: LABEL_HEIGHT };
};

/** Formats a coordinate rounded to a tenth of a pixel, which is finer than a screen can show. */
const formatCoordinate = (value: number): string => String(Math.round(value * 10) / 10);

/** Formats a point for an SVG path. */
const formatPoint = ({ x, y }: Point): string => `${formatCoordinate(x)},${formatCoordinate(y)}`;

/**
 * Builds an SVG path for a smooth curve through an edge's points. The curve
 * is the same uniform B-spline that dagre's own renderer draws. A route always
 * has at least four points: the two ends, and one point straight out from
 * each card.
 */
const buildCurve = (points: ReadonlyArray<Point>): string => {
  const [first, second] = [points[0]!, points[1]!];
  let path = `M${formatPoint(first)} L${formatPoint({ x: (5 * first.x + second.x) / 6, y: (5 * first.y + second.y) / 6 })}`;
  let [a, b] = [first, second];
  for (const next of [...points.slice(2), points.at(-1)!]) {
    path +=
      ` C${formatPoint({ x: (2 * a.x + b.x) / 3, y: (2 * a.y + b.y) / 3 })}` +
      ` ${formatPoint({ x: (a.x + 2 * b.x) / 3, y: (a.y + 2 * b.y) / 3 })}` +
      ` ${formatPoint({ x: (a.x + 4 * b.x + next.x) / 6, y: (a.y + 4 * b.y + next.y) / 6 })}`;
    [a, b] = [b, next];
  }
  return `${path} L${formatPoint(b)}`;
};

/**
 * A trigger or step as a React Flow node, drawn as a card. In a run's graph
 * the card also gets the run's moment:
 * - the run's status, because a step the run never reached recedes once the
 *   run has ended;
 * - the time now, which a running step's duration counts to.
 */
type DrawnWorkflowNode = Node<
  { readonly node: DrawableNode; readonly run: RunMoment | undefined },
  "card"
>;

/** A run at the moment it is drawn. */
interface RunMoment {
  readonly status: RunStatus;
  /** The time a running step's duration counts to, in milliseconds since the epoch. */
  readonly now: number;
}

/** An edge as a React Flow edge, drawn as a curve along its route. */
type DrawnWorkflowEdge = Edge<
  { readonly edge: DrawableEdge; readonly route: EdgeRoute; readonly markerBase: string },
  "route"
>;

/**
 * A card's connection points: on each side, one for outgoing edges and one
 * for incoming edges. An edge that closes a loop is routed back from right to
 * left, so an edge can leave or enter either side. The curves come from the
 * layout, so the handles are invisible.
 */
const HANDLES = [
  { id: "left-in", type: "target", position: Position.Left },
  { id: "left-out", type: "source", position: Position.Left },
  { id: "right-in", type: "target", position: Position.Right },
  { id: "right-out", type: "source", position: Position.Right },
] as const;

/** The handles of a card. React Flow attaches each edge to one of them. */
function CardHandles(): JSX.Element {
  return (
    <>
      {HANDLES.map((handle) => (
        <Handle
          key={handle.id}
          id={handle.id}
          type={handle.type}
          position={handle.position}
          isConnectable={false}
          className="invisible"
        />
      ))}
    </>
  );
}

/** The kind label and the id, stacked: the text of every card. */
function CardText({
  node,
  isFaded = false,
}: {
  readonly node: DrawableNode;
  readonly isFaded?: boolean;
}): JSX.Element {
  return (
    <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
      <span className="truncate text-label leading-[14px] font-emph tracking-[0.1em] text-faint uppercase">
        {KIND_LABELS[node.kind]}
      </span>{" "}
      <span
        className={cn(
          "truncate font-mono text-meta leading-5 font-emph",
          isFaded ? "text-muted" : "text-ink",
        )}
        title={node.id.length > MAX_ID_CHARACTERS ? node.id : undefined}
      >
        {node.id}
      </span>
    </span>
  );
}

/**
 * A trigger is a flat card with a thin border, because it is passive. A step
 * is raised, with a shadow, because steps do the work. In a run's graph a
 * step card is drawn by `RunStepCard` instead.
 */
function WorkflowNodeCard({ data }: NodeProps<DrawnWorkflowNode>): JSX.Element {
  const { node, run } = data;
  if (node.progress !== undefined && run !== undefined) {
    return <RunStepCard node={node} progress={node.progress} run={run} />;
  }
  const isTrigger = node.kind === "start" || node.kind === "signal";
  return (
    <div
      style={{ paddingInline: CARD_PADDING }}
      className={cn(
        "flex h-full w-full items-center rounded-card border border-line",
        isTrigger ? "bg-surface" : "bg-raised shadow-card",
      )}
    >
      <CardHandles />
      <CardText node={node} />
    </div>
  );
}

/**
 * A step in a run's graph, named by its step id. Its state is also said in
 * words for a screen reader, because the mark is decorative.
 *
 * - The state mark sits in the leading slot. A step with no step record has
 *   no mark; its card is flat and dashed, and it recedes once the run ended.
 * - The running step's border takes the live hue.
 * - The duration sits at the end, ticking while the step runs. A pending
 *   step says "pending" there instead.
 */
function RunStepCard({
  node,
  progress,
  run,
}: {
  readonly node: DrawableNode;
  readonly progress: StepProgress;
  readonly run: RunMoment;
}): JSX.Element {
  const { state } = progress;
  const isUnreached = state === "unreached";
  const elapsed = measureElapsed(progress.startedAt, progress.finishedAt, run.now);
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
      <CardHandles />
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
          elapsed !== undefined && "font-mono",
          WORK_STATE_HUES[state] ?? "text-faint",
        )}
      >
        {elapsed !== undefined ? formatElapsed(elapsed) : state === "pending" ? "pending" : ""}
      </span>
    </div>
  );
}

function WorkflowEdgeCurve({ id, data }: EdgeProps<DrawnWorkflowEdge>): JSX.Element | null {
  if (data === undefined) return null;
  const { edge, route, markerBase } = data;
  const condition = formatConditionLabel(edge);
  const badge = formatTraversalBadge(edge);
  // An edge of a workflow's graph has no travel, and is drawn like an edge
  // the run has not gone along, but solid.
  const travel = edge.travel ?? "untravelled";
  return (
    <>
      <BaseEdge
        id={id}
        path={buildCurve(route.points)}
        markerEnd={`url(#${markerBase}-${travel})`}
        className={edge.travel === "active" ? "hercule-edge-flow" : undefined}
        style={{
          stroke: EDGE_COLOURS[travel],
          strokeWidth: travel === "untravelled" ? 1.15 : 1.4,
          ...(edge.travel === "untravelled" ? { strokeDasharray: "3 4" } : {}),
        }}
      />
      {route.label === undefined ? null : (
        <EdgeLabelRenderer>
          <div
            style={{
              transform: `translate(-50%, -50%) translate(${formatCoordinate(route.label.x)}px, ${formatCoordinate(route.label.y)}px)`,
              height: LABEL_HEIGHT,
              gap: LABEL_GAP,
              paddingInline: LABEL_PADDING,
            }}
            // The background covers the curve only behind the text. The
            // padding is outside the background, so the curve stays visible
            // right up to the text.
            className="pointer-events-auto absolute flex items-center bg-surface bg-clip-content font-mono text-fine leading-none whitespace-nowrap text-muted tabular-nums"
          >
            {edge.condition === undefined ? null : (
              <>
                {/* The label shows a shortened condition. A screen reader reads the full condition. */}
                <span className="sr-only">{edge.condition}</span>
                <span aria-hidden="true" title={edge.condition}>
                  {condition}
                </span>
              </>
            )}
            {badge === undefined ? null : (
              <span
                className="rounded-control border-line py-px"
                style={{
                  paddingInline: BADGE_PADDING,
                  borderWidth: BADGE_BORDER,
                  borderStyle: "solid",
                }}
              >
                {badge}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const NODE_TYPES = { card: WorkflowNodeCard };
const EDGE_TYPES = { route: WorkflowEdgeCurve };

/**
 * The arrowheads: an open chevron with round ends, in the same style as the
 * app's marks. There is one in the colour of each kind of edge, with the id
 * `<base>-<travel>`.
 */
function ArrowMarkers({ base }: { readonly base: string }): JSX.Element {
  return (
    <svg width={0} height={0} className="absolute" aria-hidden="true">
      <defs>
        {Object.entries(EDGE_COLOURS).map(([travel, colour]) => (
          <ArrowMarker key={travel} id={`${base}-${travel}`} colour={colour} />
        ))}
      </defs>
    </svg>
  );
}

function ArrowMarker({
  id,
  colour,
}: {
  readonly id: string;
  readonly colour: string;
}): JSX.Element {
  return (
    <marker
      id={id}
      viewBox="0 0 10 10"
      refX={9}
      refY={5}
      markerWidth={ARROWHEAD_SIZE}
      markerHeight={ARROWHEAD_SIZE}
      markerUnits="userSpaceOnUse"
      orient="auto-start-reverse"
    >
      <path
        d="M2 1.5 9 5 2 8.5"
        fill="none"
        stroke={colour}
        strokeWidth={1.3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </marker>
  );
}

/**
 * Sets the viewport that `computeDrawingViewport` returns: never below a
 * readable zoom, and a small drawing scaled up.
 *
 * The drawing is placed again when the pane resizes, and when the structure
 * changes (a node or edge is added or removed, or an edge connects different
 * nodes). A new structure can have a new shape, and the old viewport could
 * cut it off at the pane's edge. A keystroke that only changes a label or an
 * id does not reset the viewport, so the author's panning is kept.
 *
 * "Fit to view" zooms out as far as needed to show the whole drawing.
 */
function DrawingPlacement({
  size,
  structure,
}: {
  readonly size: Size;
  /** A key that encodes which nodes the edges connect. Ids and labels are not part of it. */
  readonly structure: string;
}): JSX.Element {
  const { setViewport } = useReactFlow();
  const paneWidth = useStore((state) => state.width);
  const paneHeight = useStore((state) => state.height);
  const placeInPane = useEffectEvent(() => {
    if (paneWidth === 0 || paneHeight === 0) return;
    void setViewport(computeDrawingViewport({ width: paneWidth, height: paneHeight }, size));
  });
  useEffect(() => {
    placeInPane();
  }, [paneWidth, paneHeight, structure]);
  const fitToView = () => {
    if (paneWidth === 0 || paneHeight === 0) return;
    void setViewport(
      getViewportForBounds(
        { x: 0, y: 0, ...size },
        paneWidth,
        paneHeight,
        MIN_ZOOM,
        LARGEST_PLACED_ZOOM,
        FIT_PADDING,
      ),
    );
  };
  return (
    <Panel position="bottom-right" className="m-2!">
      <Button variant="quiet" className="text-meta" onClick={fitToView}>
        Fit to view
      </Button>
    </Panel>
  );
}

/**
 * What the drawing shows: a workflow, dimmed while it is older than the text
 * in the editor, or a run's plan with the time a running step counts to.
 */
type GraphViewProps =
  | {
      readonly graph: WorkflowGraph;
      /** Whether the graph shows an older version of the text than the editor. A stale graph is dimmed. */
      readonly isStale: boolean;
    }
  | {
      readonly runGraph: RunGraph;
      /** The time a running step's duration counts to, in milliseconds since the epoch. */
      readonly now: number;
    };

export function GraphView(props: GraphViewProps): JSX.Element {
  const graph: {
    readonly nodes: ReadonlyArray<DrawableNode>;
    readonly edges: ReadonlyArray<DrawableEdge>;
  } = "runGraph" in props ? props.runGraph : props.graph;
  const isStale = "isStale" in props && props.isStale;
  const run = "runGraph" in props ? { status: props.runGraph.status, now: props.now } : undefined;
  // React's ids contain characters that are not valid in a `url(#...)`
  // fragment, so they are removed.
  const markerBase = `workflow-arrow-${useId().replace(/[^\w-]/g, "")}`;
  const drawing = useMemo(() => {
    const edges = graph.edges.map((edge, index) => ({ id: `edge-${String(index)}`, edge }));
    const layout = computeGraphLayout(
      graph.nodes.map((node) => ({ id: node.id, ...measureCard(node) })),
      edges.map(({ id, edge }) => {
        const label = measureLabel(edge);
        return {
          id,
          from: edge.from,
          to: edge.to,
          ...(label === undefined ? {} : { label }),
          // Every loop in a valid workflow has an edge with maxTraversals,
          // which limits how often a run goes round the loop. That edge is
          // the one that goes back to the start of the loop.
          closesLoop: edge.maxTraversals !== undefined,
        };
      }),
      SIDE_MARGIN,
    );
    const nodes: Array<DrawnWorkflowNode> = graph.nodes.map((node) => {
      const size = measureCard(node);
      return {
        id: node.id,
        type: "card",
        position: layout.nodes.get(node.id)!,
        data: { node, run: undefined },
        ...size,
        // Handles are passed in up front, before React Flow measures the
        // cards, so the edges render in the first frame. The curves come from
        // the layout, so a handle's position on its side does not affect a
        // curve.
        handles: HANDLES.map((handle) => ({
          ...handle,
          x: handle.position === Position.Left ? 0 : size.width,
          y: size.height / 2,
        })),
      };
    });
    const routes: Array<DrawnWorkflowEdge> = edges.map(({ id, edge }) => {
      const route = layout.edges.get(id)!;
      // Find the side of each card that the route leaves and enters. The
      // route runs straight out from the card's side at each end.
      const sourceSide = route.points[1]!.x > route.points[0]!.x ? "right" : "left";
      const targetSide = route.points.at(-2)!.x < route.points.at(-1)!.x ? "left" : "right";
      return {
        id,
        type: "route",
        source: edge.from,
        target: edge.to,
        sourceHandle: `${sourceSide}-out`,
        targetHandle: `${targetSide}-in`,
        data: { edge, route, markerBase },
      };
    });
    // The structure key refers to each node by its index, not by its id, so
    // renaming a node does not change the key. Counting nodes and edges is not
    // enough: adding an edge into an entry step removes the edge from the
    // trigger into it, so the count can stay the same.
    const nodeIndexes = new Map(graph.nodes.map((node, index) => [node.id, index]));
    const structure = [
      graph.nodes.length,
      ...graph.edges.map(
        (edge) => `${String(nodeIndexes.get(edge.from))}>${String(nodeIndexes.get(edge.to))}`,
      ),
    ].join(" ");
    return { nodes, edges: routes, size: layout.size, structure };
  }, [graph, markerBase]);
  // The time now changes on every tick of a running step's duration, while
  // the graph, and so the layout, stays the same object until the run
  // changes. So the time is added to the cards after the layout.
  const nodes =
    run === undefined
      ? drawing.nodes
      : drawing.nodes.map((node) => ({ ...node, data: { ...node.data, run } }));

  return (
    // A stale graph dims its nodes, edges and labels, which are all inside
    // React Flow's viewport element, but not its controls. The class name is
    // written out in full because Tailwind reads `_` as a space unless it is
    // escaped, and the viewport's class contains `__`.
    <div
      data-stale={isStale ? "" : undefined}
      className="relative h-full w-full data-stale:[&_.react-flow\_\_viewport]:opacity-50"
    >
      <ArrowMarkers base={markerBase} />
      <ReactFlow
        nodes={nodes}
        edges={drawing.edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <DrawingPlacement size={drawing.size} structure={drawing.structure} />
      </ReactFlow>
    </div>
  );
}
