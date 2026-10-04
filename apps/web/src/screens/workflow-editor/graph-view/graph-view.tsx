/**
 * A read-only drawing of a workflow graph: a card for each trigger and step,
 * and a curve for each edge with its condition and traversal limit. The
 * layout engine (dagre) positions the cards. React Flow draws them and
 * provides pan, zoom and "Fit to view". This folder is the only place that
 * imports React Flow, so the library can be replaced here alone.
 *
 * The workflow editor draws a workflow with the default cards and edges. A
 * run's page draws a run's plan with this same drawing, and passes its own
 * step cards and edge styles to show where the run is.
 */
import "@xyflow/react/dist/base.css";
import {
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  type ComponentType,
  type JSX,
  type ReactNode,
} from "react";
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
  shortenCondition,
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
} from "@hercule/client-core";
import { Button, cn, useElementWidth } from "@hercule/ui";
import {
  computeDrawingViewport,
  computeGraphLayout,
  computePaneHeight,
  LARGEST_PLACED_ZOOM,
  MIN_ZOOM,
  type EdgeRoute,
  type PaneSizing,
  type Point,
  type Size,
} from "./layout";

/**
 * Every glyph of IBM Plex Mono, the font of the ids and edge labels, is 0.6em
 * wide. So a text's width can be computed from its length, and the size of
 * every card and label is known before anything is rendered. Cards
 * and labels are rendered with the same sizes, padding and borders they are
 * measured with, so nothing overlaps a card.
 */
const MONO_GLYPH_WIDTH = 0.6;

/** Returns the width of a text in IBM Plex Mono at a font size. */
export const measureMonoText = (text: string, fontSize: number): number =>
  Math.ceil([...text].length * fontSize * MONO_GLYPH_WIDTH);

const CARD_HEIGHT = 52;
/** The width of a card with a short id. It fits every kind label, and an id of 14 characters. */
const MIN_CARD_WIDTH = 136;
/**
 * The width of a terminal step's card with a short id. It fits "Action step ·
 * Ends run", which renders 154px wide, with a few pixels to spare.
 */
const MIN_TERMINAL_CARD_WIDTH = 184;
/** The font size of a card's id, `text-meta`. */
const ID_FONT_SIZE = 12.5;
/**
 * The space between a card's border and its text. A card passed in through
 * `Card` uses it too, because the layout measures every card with it.
 */
export const CARD_PADDING = 12;
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

/**
 * Returns the size of a node's card: wide enough for its id, up to
 * `MAX_ID_CHARACTERS`, plus `slotWidth` for what the card holds beside its
 * text.
 */
const measureCard = (node: WorkflowGraphNode, slotWidth: number): Size => ({
  width:
    Math.max(
      node.terminal === true ? MIN_TERMINAL_CARD_WIDTH : MIN_CARD_WIDTH,
      measureMonoText(node.id.slice(0, MAX_ID_CHARACTERS), ID_FONT_SIZE) +
        2 * (CARD_PADDING + CARD_BORDER),
    ) + slotWidth,
  height: CARD_HEIGHT,
});

/** The font size of an edge label, `text-fine`. */
const LABEL_FONT_SIZE = 12;
const LABEL_HEIGHT = 20;
const LABEL_PADDING = 6;
const LABEL_GAP = 6;
const BADGE_PADDING = 4;
const BADGE_BORDER = 1;

/** How an edge's curve is drawn. Its arrowhead takes the curve's colour. */
export interface EdgeStyle {
  /** A CSS colour. */
  readonly colour: string;
  /** The width of the curve, in pixels. */
  readonly width: number;
  /** An SVG `stroke-dasharray`, or `undefined` for a solid curve. */
  readonly dashArray?: string;
  /** A class for the curve, for a style that SVG attributes cannot set, such as an animation. */
  readonly className?: string;
  /** The opacity of the curve and of its label's text, or `undefined` for opaque. */
  readonly opacity?: number;
}

/** The outlined badge an edge's label shows after its condition, such as `max 3`. */
export interface EdgeBadge {
  readonly text: string;
  /** A class for the badge's text, such as a colour. */
  readonly className?: string;
}

/**
 * The style of an edge of a workflow: a thin, solid curve in the faint colour
 * mixed 20% towards the muted colour. This gives lines a 3:1 contrast on the
 * surface in both themes, the minimum for a graphic that carries meaning.
 */
export const WORKFLOW_EDGE_STYLE: EdgeStyle = {
  colour: "color-mix(in oklch, var(--faint), var(--muted) 20%)",
  width: 1.15,
};

/** Returns the style of every edge of a workflow, `WORKFLOW_EDGE_STYLE`. */
const decideWorkflowEdgeStyle = (): EdgeStyle => WORKFLOW_EDGE_STYLE;

const MAX_ZOOM = 1.5;
/** The padding around the drawing for "Fit to view", as a fraction of the pane. */
const FIT_PADDING = 0.08;

/**
 * The label a card shows for each node kind. A terminal step's label adds
 * "Ends run", because the run ends when that step completes.
 */
const KIND_LABELS: Record<WorkflowGraphNode["kind"], string> = {
  start: "Start trigger",
  signal: "Signal trigger",
  action: "Action step",
  agent: "Agent step",
};

/** Returns the badge of a workflow's edge with a traversal limit, `max 3`, or `undefined` for none. */
const describeTraversalLimit = (edge: WorkflowGraphEdge): EdgeBadge | undefined =>
  edge.maxTraversals === undefined ? undefined : { text: `max ${String(edge.maxTraversals)}` };

/** Returns the condition an edge's label shows, shortened when too long. */
const formatConditionLabel = (edge: WorkflowGraphEdge): string | undefined => {
  const condition = abbreviateEdgeCondition(edge);
  return condition === undefined ? undefined : shortenCondition(condition);
};

/** Returns the size of an edge's label, or `undefined` for an edge with no condition and no badge. */
const measureLabel = (edge: WorkflowGraphEdge, badge: EdgeBadge | undefined): Size | undefined => {
  const condition = formatConditionLabel(edge);
  if (condition === undefined && badge === undefined) return undefined;
  const conditionWidth = condition === undefined ? 0 : measureMonoText(condition, LABEL_FONT_SIZE);
  const badgeWidth =
    badge === undefined
      ? 0
      : measureMonoText(badge.text, LABEL_FONT_SIZE) + 2 * (BADGE_PADDING + BADGE_BORDER);
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
 * A trigger or step as a React Flow node. Its card element is created once,
 * with the layout, so a card that changes on its own, such as a running
 * step's ticking duration, re-renders without a new node.
 */
type DrawnWorkflowNode = Node<{ readonly card: ReactNode }, "card">;

/** An edge as a React Flow edge, drawn as a curve along its route. */
type DrawnWorkflowEdge = Edge<
  {
    readonly edge: WorkflowGraphEdge;
    readonly route: EdgeRoute;
    readonly style: EdgeStyle;
    readonly badge: EdgeBadge | undefined;
    /** The id of the arrowhead marker in the edge's colour. */
    readonly markerId: string;
  },
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

/**
 * Renders a node's card with its handles, to which React Flow attaches the
 * edges. The handles are positioned against React Flow's node element, so
 * they sit beside the card rather than inside it.
 */
function CardNode({ data }: NodeProps<DrawnWorkflowNode>): JSX.Element {
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
      {data.card}
    </>
  );
}

/**
 * Renders the kind label and the id, stacked: the text of every card. A
 * `note`, such as a run step's iteration count, follows the id in the faint
 * colour.
 */
export function CardText({
  node,
  isFaded = false,
  note,
}: {
  readonly node: WorkflowGraphNode;
  readonly isFaded?: boolean;
  readonly note?: string | undefined;
}): JSX.Element {
  return (
    <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
      <span className="truncate text-label leading-[14px] font-emph tracking-[0.1em] text-faint uppercase">
        {KIND_LABELS[node.kind]}
        {node.terminal === true ? " · Ends run" : ""}
      </span>{" "}
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span
          className={cn(
            "truncate font-mono text-meta leading-5 font-emph",
            isFaded ? "text-muted" : "text-ink",
          )}
          title={node.id.length > MAX_ID_CHARACTERS ? node.id : undefined}
        >
          {node.id}
        </span>{" "}
        {note === undefined ? null : (
          <span className="shrink-0 font-mono text-fine text-faint">{note}</span>
        )}
      </span>
    </span>
  );
}

/**
 * Renders the card of a trigger or step of a workflow. A trigger is a flat
 * card with a thin border, because it is passive. A step is raised, with a
 * shadow, because steps do the work. A `note` follows the id, as a run's
 * page notes how often a signal trigger fired, such as `×2`.
 */
export function WorkflowNodeCard({
  node,
  note,
}: {
  readonly node: WorkflowGraphNode;
  readonly note?: string | undefined;
}): JSX.Element {
  const isTrigger = node.kind === "start" || node.kind === "signal";
  return (
    <div
      style={{ paddingInline: CARD_PADDING }}
      className={cn(
        "flex h-full w-full items-center rounded-card border border-line",
        isTrigger ? "bg-surface" : "bg-raised shadow-card",
      )}
    >
      <CardText node={node} note={note} />
    </div>
  );
}

/** Renders an edge: its curve along its route, and its label when it has one. */
function WorkflowEdgeCurve({ id, data }: EdgeProps<DrawnWorkflowEdge>): JSX.Element | null {
  if (data === undefined) return null;
  const { edge, route, style, badge, markerId } = data;
  const condition = formatConditionLabel(edge);
  // The label's background stays opaque, so only its text fades with the curve.
  const textStyle = style.opacity === undefined ? {} : { opacity: style.opacity };
  return (
    <>
      <BaseEdge
        id={id}
        path={buildCurve(route.points)}
        markerEnd={`url(#${markerId})`}
        className={style.className}
        style={{
          stroke: style.colour,
          strokeWidth: style.width,
          ...(style.dashArray === undefined ? {} : { strokeDasharray: style.dashArray }),
          ...textStyle,
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
            // The background, in the pane's colour, covers the curve behind
            // the text and its padding, so the curve stops short of the text
            // instead of running into it.
            className="pointer-events-auto absolute flex items-center bg-surface font-mono text-fine leading-none whitespace-nowrap text-muted tabular-nums"
          >
            {edge.condition === undefined ? null : (
              <>
                {/* The label shows a shortened condition. A screen reader reads the full condition. */}
                <span className="sr-only">{edge.condition}</span>
                <span aria-hidden="true" title={edge.condition} style={textStyle}>
                  {condition}
                </span>
              </>
            )}
            {badge === undefined ? null : (
              <span
                className={cn("rounded-control border-line py-px", badge.className)}
                style={{
                  paddingInline: BADGE_PADDING,
                  borderWidth: BADGE_BORDER,
                  borderStyle: "solid",
                  ...textStyle,
                }}
              >
                {badge.text}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const NODE_TYPES = { card: CardNode };
const EDGE_TYPES = { route: WorkflowEdgeCurve };

/** Builds the id of the arrowhead marker for the colour at `index` of the drawing's edge colours. */
const buildMarkerId = (base: string, index: number): string => `${base}-${String(index)}`;

/**
 * Renders the arrowheads: an open chevron with round ends, in the same style
 * as the app's marks. There is one for each colour of the drawing's edges,
 * with the id `buildMarkerId` builds for the colour's index.
 */
function ArrowMarkers({
  base,
  colours,
}: {
  readonly base: string;
  readonly colours: ReadonlyArray<string>;
}): JSX.Element {
  return (
    <svg width={0} height={0} className="absolute" aria-hidden="true">
      <defs>
        {colours.map((colour, index) => (
          <ArrowMarker key={colour} id={buildMarkerId(base, index)} colour={colour} />
        ))}
      </defs>
    </svg>
  );
}

/** Renders one arrowhead marker, in `colour`. */
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
 * Sets the viewport that `computeDrawingViewport` returns: never below
 * `smallestZoom`, and a small drawing scaled up.
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
  smallestZoom,
}: {
  readonly size: Size;
  readonly smallestZoom: number;
  /** A key that encodes which nodes the edges connect. Ids and labels are not part of it. */
  readonly structure: string;
}): JSX.Element {
  const { setViewport } = useReactFlow();
  const paneWidth = useStore((state) => state.width);
  const paneHeight = useStore((state) => state.height);
  const placeInPane = useEffectEvent(() => {
    if (paneWidth === 0 || paneHeight === 0) return;
    void setViewport(
      computeDrawingViewport({ width: paneWidth, height: paneHeight }, size, smallestZoom),
    );
  });
  useEffect(() => {
    placeInPane();
  }, [paneWidth, paneHeight, structure, smallestZoom]);
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

/** Returns no width for what a card holds beside its text: a default card holds only its text. */
const measureNoCardSlots = (): number => 0;

/**
 * Renders a graph: a workflow's, or a run's plan with the run's progress on
 * it. Every node is drawn by `Card`, every edge in the style that
 * `decideEdgeStyle` returns for it, with the badge `describeEdgeBadge`
 * returns. Without them, the drawing shows a workflow: `WorkflowNodeCard`,
 * `WORKFLOW_EDGE_STYLE`, and a `max n` badge on an edge with a traversal
 * limit.
 *
 * The layout is computed again only when the graph or one of these props
 * changes, so the caller passes stable functions and components: a module's
 * own, not ones created during a render.
 */
export function GraphView<
  GraphNode extends WorkflowGraphNode,
  GraphEdge extends WorkflowGraphEdge,
>({
  graph,
  isStale = false,
  Card = WorkflowNodeCard,
  measureCardSlots = measureNoCardSlots,
  decideEdgeStyle = decideWorkflowEdgeStyle,
  describeEdgeBadge = describeTraversalLimit,
  sizing,
  className,
}: {
  readonly graph: {
    readonly nodes: ReadonlyArray<GraphNode>;
    readonly edges: ReadonlyArray<GraphEdge>;
  };
  /** Whether the graph shows an older version of the text than the editor. A stale graph is dimmed. */
  readonly isStale?: boolean;
  /** Renders a node's card. A card fills its node, and uses `CARD_PADDING` and `CardText`. */
  readonly Card?: ComponentType<{ readonly node: GraphNode }>;
  /** Returns the width, in pixels, of what a node's card holds beside its kind label and id. */
  readonly measureCardSlots?: (node: GraphNode) => number;
  /** Returns the style of an edge's curve. */
  readonly decideEdgeStyle?: (edge: GraphEdge) => EdgeStyle;
  /** Returns the badge an edge's label shows, or `undefined` for none. */
  readonly describeEdgeBadge?: (edge: GraphEdge) => EdgeBadge | undefined;
  /**
   * How the pane sizes itself to the drawing. Without it, the pane fills its
   * parent and the drawing opens whole, however small.
   */
  readonly sizing?: PaneSizing;
  /** A class for the pane, such as its border. */
  readonly className?: string;
}): JSX.Element {
  // React's ids contain characters that are not valid in a `url(#...)`
  // fragment, so they are removed.
  const markerBase = `workflow-arrow-${useId().replace(/[^\w-]/g, "")}`;
  const drawing = useMemo(() => {
    const edges = graph.edges.map((edge, index) => ({
      id: `edge-${String(index)}`,
      edge,
      badge: describeEdgeBadge(edge),
    }));
    const sizes = new Map(
      graph.nodes.map((node) => [node.id, measureCard(node, measureCardSlots(node))]),
    );
    const layout = computeGraphLayout(
      graph.nodes.map((node) => ({ id: node.id, ...sizes.get(node.id)! })),
      edges.map(({ id, edge, badge }) => {
        const label = measureLabel(edge, badge);
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
      const size = sizes.get(node.id)!;
      return {
        id: node.id,
        type: "card",
        position: layout.nodes.get(node.id)!,
        data: { card: <Card node={node} /> },
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
    const styles = edges.map(({ edge }) => decideEdgeStyle(edge));
    const colours = [...new Set(styles.map((style) => style.colour))];
    const routes: Array<DrawnWorkflowEdge> = edges.map(({ id, edge, badge }, index) => {
      const route = layout.edges.get(id)!;
      const style = styles[index]!;
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
        data: {
          edge,
          route,
          style,
          badge,
          markerId: buildMarkerId(markerBase, colours.indexOf(style.colour)),
        },
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
    return { nodes, edges: routes, colours, size: layout.size, structure };
  }, [graph, markerBase, Card, measureCardSlots, decideEdgeStyle, describeEdgeBadge]);

  const { observeElement: observePane, width: paneWidth } = useElementWidth();

  return (
    // A stale graph dims its nodes, edges and labels, which are all inside
    // React Flow's viewport element, but not its controls. The class name is
    // written out in full because Tailwind reads `_` as a space unless it is
    // escaped, and the viewport's class contains `__`. A height from
    // `sizing` overrides `h-full`.
    <div
      // Only a pane that sizes itself to the plan needs its width.
      ref={sizing === undefined ? undefined : observePane}
      data-stale={isStale ? "" : undefined}
      style={
        sizing === undefined
          ? undefined
          : {
              // An unmeasured pane is taken as infinitely wide, which gives
              // the drawing its largest zoom.
              height: computePaneHeight(
                paneWidth ?? Number.POSITIVE_INFINITY,
                drawing.size,
                sizing,
              ),
            }
      }
      className={cn(
        String.raw`relative h-full w-full data-stale:[&_.react-flow\_\_viewport]:opacity-50`,
        className,
      )}
    >
      <ArrowMarkers base={markerBase} colours={drawing.colours} />
      <ReactFlow
        nodes={drawing.nodes}
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
        <DrawingPlacement
          size={drawing.size}
          structure={drawing.structure}
          smallestZoom={sizing?.smallestPlacedZoom ?? MIN_ZOOM}
        />
      </ReactFlow>
    </div>
  );
}
