/**
 * The workflow's graph, drawn read-only: a card for each trigger and step, and
 * a curve for each edge with its condition and its cap. The layout engine
 * places the cards, and the graph library draws them and gives pan, zoom and
 * fit to view. This folder is the one place that imports the graph library,
 * so the library can be replaced here alone.
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
  type WorkflowGraph,
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
} from "@hercule/client-core";
import { Button, cn } from "@hercule/ui";
import {
  computeGraphLayout,
  LARGEST_PLACED_ZOOM,
  placeDrawing,
  type EdgeRoute,
  type Point,
  type Size,
} from "./layout";

/**
 * Every card has one size, so the layout knows it before anything is drawn.
 * The width holds the kind of a card and an id of 14 characters. A longer id
 * is cut short, and the whole id is the title of the card's id.
 */
const CARD_SIZE: Size = { width: 136, height: 52 };

/**
 * An edge label is set in IBM Plex Mono at the fine size of the type scale,
 * `text-fine`, and each glyph of that face is 0.6em wide. So the width of a
 * label follows from its characters. The layout gets that width, and the
 * label is drawn with the same padding, gap and widths as it is measured
 * with, so no label overlaps a card.
 */
const LABEL_FONT_SIZE = 12;
const LABEL_CHARACTER_WIDTH = LABEL_FONT_SIZE * 0.6;
const LABEL_HEIGHT = 20;
const LABEL_PADDING = 6;
const LABEL_GAP = 6;
const BADGE_PADDING = 4;
const BADGE_BORDER = 1;
/**
 * How many characters of a condition a label shows. A longer condition shows
 * its end, after an ellipsis, because two branches of one step usually differ
 * at the end of their conditions. The whole condition is the label's title.
 */
const MAX_CONDITION_CHARACTERS = 24;

/**
 * The colour of the edges and their arrowheads: the faint ink, one fifth of
 * the way to the muted ink, so that a line has a contrast of 3:1 on the
 * surface in both themes, as a graphic that carries meaning must.
 */
const EDGE_COLOUR = "color-mix(in oklch, var(--faint), var(--muted) 20%)";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1.5;
/** The space around the drawing, as a part of the pane, when the author asks to see all of it. */
const FIT_PADDING = 0.08;

/** What a card calls the kind of its node. */
const KIND_LABELS: Record<WorkflowGraphNode["kind"], string> = {
  start: "Start trigger",
  signal: "Signal trigger",
  action: "Action step",
  agent: "Agent step",
};

/** The badge of an edge that may fire a limited number of times in one run. */
const formatTraversalBadge = (edge: WorkflowGraphEdge): string | undefined =>
  edge.maxTraversals === undefined ? undefined : `max ${String(edge.maxTraversals)}`;

/** The condition that an edge's label shows, cut to its end where it is too long. */
const formatConditionLabel = (edge: WorkflowGraphEdge): string | undefined => {
  const condition = abbreviateEdgeCondition(edge);
  if (condition === undefined) return undefined;
  const characters = [...condition];
  return characters.length <= MAX_CONDITION_CHARACTERS
    ? condition
    : `…${characters.slice(1 - MAX_CONDITION_CHARACTERS).join("")}`;
};

const measureText = (text: string): number => Math.ceil([...text].length * LABEL_CHARACTER_WIDTH);

/** The size an edge's label is drawn at, or `undefined` for an edge with nothing to say. */
const measureLabel = (edge: WorkflowGraphEdge): Size | undefined => {
  const condition = formatConditionLabel(edge);
  const badge = formatTraversalBadge(edge);
  if (condition === undefined && badge === undefined) return undefined;
  const conditionWidth = condition === undefined ? 0 : measureText(condition);
  const badgeWidth =
    badge === undefined ? 0 : measureText(badge) + 2 * (BADGE_PADDING + BADGE_BORDER);
  const gap = conditionWidth > 0 && badgeWidth > 0 ? LABEL_GAP : 0;
  return { width: conditionWidth + gap + badgeWidth + 2 * LABEL_PADDING, height: LABEL_HEIGHT };
};

/** A coordinate as text, to a tenth of a pixel, which is finer than a screen shows. */
const formatCoordinate = (value: number): string => String(Math.round(value * 10) / 10);

/** A point as the path of an SVG writes it. */
const formatPoint = ({ x, y }: Point): string => `${formatCoordinate(x)},${formatCoordinate(y)}`;

/**
 * A smooth curve through an edge's points: the uniform B-spline that the
 * layout engine's own renderer draws its points with. A route has at least
 * four points: each end, and a point straight out of each card.
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

/** A trigger or a step as the graph library draws it: a card. */
type DrawnWorkflowNode = Node<{ readonly node: WorkflowGraphNode }, "card">;

/** An edge as the graph library draws it: a curve along its route. */
type DrawnWorkflowEdge = Edge<
  { readonly edge: WorkflowGraphEdge; readonly route: EdgeRoute; readonly markerId: string },
  "route"
>;

/**
 * The handles of a card: one on each side for the edges that leave it and
 * one for the edges that enter it. The layout routes an edge back from right
 * to left where it closes a loop, so an edge can leave or enter either side.
 * The curves come from the layout, so the handles are not shown.
 */
const HANDLES = [
  { id: "left-in", type: "target", position: Position.Left },
  { id: "left-out", type: "source", position: Position.Left },
  { id: "right-in", type: "target", position: Position.Right },
  { id: "right-out", type: "source", position: Position.Right },
] as const;

/**
 * A trigger is a flat card with a hairline, because it is passive. A step is
 * lit, on the raised layer, because the steps are the work. The graph library
 * attaches each edge to a handle.
 */
function WorkflowNodeCard({ data }: NodeProps<DrawnWorkflowNode>): JSX.Element {
  const { node } = data;
  const isTrigger = node.kind === "start" || node.kind === "signal";
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col justify-center gap-0.5 rounded-card border border-line px-3",
        isTrigger ? "bg-surface" : "bg-raised shadow-card",
      )}
    >
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
      <span className="truncate text-label leading-[14px] font-emph tracking-[0.1em] text-faint uppercase">
        {KIND_LABELS[node.kind]}
      </span>
      <span className="truncate font-mono text-meta leading-5 font-emph text-ink" title={node.id}>
        {node.id}
      </span>
    </div>
  );
}

function WorkflowEdgeCurve({ id, data }: EdgeProps<DrawnWorkflowEdge>): JSX.Element | null {
  if (data === undefined) return null;
  const { edge, route, markerId } = data;
  const condition = formatConditionLabel(edge);
  const badge = formatTraversalBadge(edge);
  return (
    <>
      <BaseEdge
        id={id}
        path={buildCurve(route.points)}
        markerEnd={`url(#${markerId})`}
        style={{ stroke: EDGE_COLOUR, strokeWidth: 1.15 }}
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
            // The ground hides the curve behind the text only. The padding is
            // outside it, so the curve stays whole where it meets the label.
            className="pointer-events-auto absolute flex items-center bg-surface bg-clip-content font-mono text-fine leading-none whitespace-nowrap text-muted tabular-nums"
          >
            {edge.condition === undefined ? null : (
              <>
                {/* The label shows a short form of the condition. A screen reader reads the whole condition. */}
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

/** The arrowhead: an open chevron with round ends, drawn as the marks are. */
function ArrowMarker({ id }: { readonly id: string }): JSX.Element {
  return (
    <svg width={0} height={0} className="absolute" aria-hidden="true">
      <defs>
        <marker
          id={id}
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={9}
          markerHeight={9}
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path
            d="M2 1.5 9 5 2 8.5"
            fill="none"
            stroke={EDGE_COLOUR}
            strokeWidth={1.3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </marker>
      </defs>
    </svg>
  );
}

/**
 * Places the drawing in the pane. On its own, it draws the drawing at the
 * legible zoom and never smaller, and a small drawing larger, as
 * `placeDrawing` says. It places the drawing again when the pane changes
 * size and when the structure changes: a node or an edge comes or goes, or
 * an edge joins other nodes. A new structure can have a new shape, and the old place
 * can cut the new shape at the pane's edge. It does not place the drawing
 * again at each keystroke that changes a label or an id, so that a place the
 * author panned to stays. "Fit to view" is the author asking to see all of
 * the drawing, so it makes the drawing as small as it must be to fit.
 */
function DrawingPlacement({
  size,
  structure,
}: {
  readonly size: Size;
  /** Which nodes the edges join. Ids and labels are not part of it. */
  readonly structure: string;
}): JSX.Element {
  const { setViewport } = useReactFlow();
  const paneWidth = useStore((state) => state.width);
  const paneHeight = useStore((state) => state.height);
  const placeInPane = useEffectEvent(() => {
    if (paneWidth === 0 || paneHeight === 0) return;
    void setViewport(placeDrawing({ width: paneWidth, height: paneHeight }, size));
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

export function GraphView({
  graph,
  isStale,
}: {
  readonly graph: WorkflowGraph;
  /** Whether the graph is of an earlier text than the one the author sees, which dims it. */
  readonly isStale: boolean;
}): JSX.Element {
  // An id that `url(#...)` can name: React's ids hold characters that a URL
  // fragment does not take as they are.
  const markerId = `workflow-arrow-${useId().replace(/[^\w-]/g, "")}`;
  const drawing = useMemo(() => {
    const edges = graph.edges.map((edge, index) => ({ id: `edge-${String(index)}`, edge }));
    const layout = computeGraphLayout(
      graph.nodes.map((node) => ({ id: node.id, ...CARD_SIZE })),
      edges.map(({ id, edge }) => {
        const label = measureLabel(edge);
        return {
          id,
          from: edge.from,
          to: edge.to,
          ...(label === undefined ? {} : { label }),
          // Every loop of a valid workflow has an edge with maxTraversals,
          // which bounds how often a run goes round. That edge is the one
          // that goes back to the start of the loop.
          closesLoop: edge.maxTraversals !== undefined,
        };
      }),
    );
    const nodes: Array<DrawnWorkflowNode> = graph.nodes.map((node) => ({
      id: node.id,
      type: "card",
      position: layout.nodes.get(node.id)!,
      data: { node },
      ...CARD_SIZE,
      // Where the edges attach, given before the cards are measured, so the
      // edges are drawn in the first frame.
      handles: HANDLES.map((handle) => ({
        ...handle,
        x: handle.position === Position.Left ? 0 : CARD_SIZE.width,
        y: CARD_SIZE.height / 2,
      })),
    }));
    const routes: Array<DrawnWorkflowEdge> = edges.map(({ id, edge }) => {
      const route = layout.edges.get(id)!;
      // The side of each card that the route leaves and enters: the route
      // runs straight out of the side of the card at each end.
      const sourceSide = route.points[1]!.x > route.points[0]!.x ? "right" : "left";
      const targetSide = route.points.at(-2)!.x < route.points.at(-1)!.x ? "left" : "right";
      return {
        id,
        type: "route",
        source: edge.from,
        target: edge.to,
        sourceHandle: `${sourceSide}-out`,
        targetHandle: `${targetSide}-in`,
        data: { edge, route, markerId },
      };
    });
    // The structure names each node by its place in the list, not by its id,
    // so a rename keeps it. A count of the nodes and the edges is not enough:
    // an edge into an entry step removes the edge from the trigger into it.
    const nodePlaces = new Map(graph.nodes.map((node, place) => [node.id, place]));
    const structure = [
      graph.nodes.length,
      ...graph.edges.map(
        (edge) => `${String(nodePlaces.get(edge.from))}>${String(nodePlaces.get(edge.to))}`,
      ),
    ].join(" ");
    return { nodes, edges: routes, size: layout.size, structure };
  }, [graph, markerId]);

  return (
    // A stale graph dims its nodes, its edges and their labels, which are all
    // inside the graph library's viewport, and not its controls. The class is
    // a literal because the class scanner reads `_` as a space unless it is
    // escaped, and the viewport's class holds `__`.
    <div
      data-stale={isStale ? "" : undefined}
      className="relative h-full w-full data-stale:[&_.react-flow\_\_viewport]:opacity-50"
    >
      <ArrowMarker id={markerId} />
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
        <DrawingPlacement size={drawing.size} structure={drawing.structure} />
      </ReactFlow>
    </div>
  );
}
