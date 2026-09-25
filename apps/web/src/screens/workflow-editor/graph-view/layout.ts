/**
 * Lays out a graph from left to right, in ranks (columns). This file is the
 * only place that imports the layout engine, dagre, so the engine can be
 * replaced here alone.
 *
 * - dagre positions the nodes and labels, and routes each edge through its
 *   own points, leaving room for each label.
 * - Each edge attaches to the side of its node that its route leaves or
 *   enters. Edges on the same side are spread out, each at its own point,
 *   clear of the node's corners.
 * - dagre does not handle an edge from a node to itself. This file routes it
 *   out of the node's right side, over the top, and back in from the left.
 */
import { graphlib, layout, type EdgeLabel, type GraphLabel, type NodeLabel } from "@dagrejs/dagre";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** A node to position, with its rendered size. */
interface LayoutNode extends Size {
  readonly id: string;
}

/** An edge to route, with its label's size if it has a label, so the layout leaves room for it. */
interface LayoutEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label?: Size;
  /**
   * Whether the edge goes back to the start of a loop. The layout draws such
   * an edge from right to left, so the rest of the loop reads from left to
   * right. An edge that is not part of any loop is drawn forward even when
   * this is true.
   */
  readonly closesLoop?: boolean;
}

/**
 * The path of an edge: the points its curve follows, and the centre of its
 * label. The curve is the smooth curve that dagre's own renderer draws
 * through such points. It starts at the first point, ends at the last, and
 * passes near each point in between. A repeated point makes a tight corner.
 */
export interface EdgeRoute {
  readonly points: ReadonlyArray<Point>;
  readonly label?: Point;
}

interface GraphLayout {
  /** The top-left corner of each node, keyed by node id. */
  readonly nodes: ReadonlyMap<string, Point>;
  /** The route of each edge, keyed by edge id. */
  readonly edges: ReadonlyMap<string, EdgeRoute>;
  /** The size of the bounding box of all nodes, edges and labels, which starts at the origin. */
  readonly size: Size;
}

/** The gap between two nodes in the same rank. */
const NODE_GAP = 20;

/** The gap between two ranks. An edge label gets its own rank between them. */
const RANK_GAP = 40;

/** The gap between two parallel edges. */
const EDGE_GAP = 12;

/**
 * How far an edge runs straight out of its source and straight into its
 * target, so it meets each card's side at a right angle.
 */
const STRAIGHT_RUN = 8;

/** How far beside its node a self-loop turns up and down. */
const TURN_OFFSET = 16;

/**
 * The gap between the top of a node and the horizontal line of its self-loop.
 * The label sits on the line, so the gap holds half a label plus some space
 * below it.
 */
const LOOP_RISE = 24;

/** The gap between a self-loop's label and the loop's vertical parts. */
const LABEL_CLEARANCE = 8;

/** A rectangle in the drawing: its top-left corner and its size. */
interface Box extends Point, Size {}

/** Builds the rectangle of a given size centred on a point. */
const buildCentredBox = (centre: Point, size: Size): Box => ({
  x: centre.x - size.width / 2,
  y: centre.y - size.height / 2,
  ...size,
});

/**
 * Returns the edges that are part of a loop. An edge is part of a loop when
 * a path leads from its target back to its source.
 */
const findLoopEdges = (edges: ReadonlyArray<LayoutEdge>): ReadonlySet<LayoutEdge> => {
  const successors = new Map<string, Array<string>>();
  for (const edge of edges)
    successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to]);
  const leadsTo = (start: string, goal: string): boolean => {
    const reached = new Set([start]);
    // A Set iteration also visits items added during the iteration, so this
    // loop is a breadth-first search.
    for (const id of reached) {
      if (id === goal) return true;
      for (const next of successors.get(id) ?? []) reached.add(next);
    }
    return false;
  };
  return new Set(edges.filter((edge) => leadsTo(edge.to, edge.from)));
};

/**
 * Returns the points of a self-loop from `start` on a card's right side to
 * `end` on its left side, along the horizontal line at `overpassY` above the
 * card. The loop turns up and down `turnOffset` beside the card.
 */
const routeLoopOverCard = (
  start: Point,
  end: Point,
  overpassY: number,
  turnOffset: number,
): ReadonlyArray<Point> => {
  const corners = [
    { x: start.x + turnOffset, y: start.y },
    { x: start.x + turnOffset, y: overpassY },
    { x: end.x - turnOffset, y: overpassY },
    { x: end.x - turnOffset, y: end.y },
  ];
  return [start, ...corners.flatMap((corner) => [corner, corner]), end];
};

/** One end of an edge on one side of a card, with its sort order along that side. */
interface SideAttachment {
  /** Which end of which edge: `start <edge id>` or `end <edge id>`. */
  readonly key: string;
  /** The top-to-bottom sort key: by the first number, then by the second. */
  readonly order: readonly [number, number];
}

/** The shape of a self-loop above its node. */
interface LoopPlan {
  readonly edge: LayoutEdge;
  /** How far beside the node the loop turns up and down. */
  readonly turnOffset: number;
  /** How far above the top of the node the loop runs. */
  readonly rise: number;
}

/**
 * Returns the shape of every self-loop, keyed by node id. A node's loops
 * stack above it. Each loop runs above the label of the loop below it and is
 * wider than that loop, so no loop crosses another loop's label or vertical
 * parts. Each loop is wide enough for its label to fit between its two
 * vertical parts.
 */
const planLoops = (
  nodes: ReadonlyArray<LayoutNode>,
  loops: ReadonlyArray<LayoutEdge>,
): ReadonlyMap<string, ReadonlyArray<LoopPlan>> => {
  const plans = new Map<string, ReadonlyArray<LoopPlan>>();
  for (const node of nodes) {
    const nodePlans: Array<LoopPlan> = [];
    for (const edge of loops.filter((loop) => loop.from === node.id)) {
      const previous = nodePlans.at(-1);
      nodePlans.push({
        edge,
        turnOffset: Math.max(
          TURN_OFFSET,
          ((edge.label?.width ?? 0) - node.width) / 2 + LABEL_CLEARANCE,
          previous === undefined ? 0 : previous.turnOffset + EDGE_GAP,
        ),
        rise:
          (previous === undefined ? 0 : previous.rise + (previous.edge.label?.height ?? 0) / 2) +
          LOOP_RISE,
      });
    }
    if (nodePlans.length > 0) plans.set(node.id, nodePlans);
  }
  return plans;
};

/**
 * Computes the position of each node and the route of each edge.
 *
 * An edge that closes a loop is passed to dagre reversed, so dagre ranks it
 * as the edge that goes back. A self-loop gets room above its node.
 * `sideMargin` is the length at each end of a node's side where no edge
 * attaches: the card's rounded corner plus room for half an arrowhead.
 */
export const computeGraphLayout = (
  nodes: ReadonlyArray<LayoutNode>,
  edges: ReadonlyArray<LayoutEdge>,
  sideMargin: number,
): GraphLayout => {
  const selfLoops = edges.filter((edge) => edge.from === edge.to);
  const routedEdges = edges.filter((edge) => edge.from !== edge.to);
  const loopEdges = findLoopEdges(routedEdges);
  const isDrawnBackwards = (edge: LayoutEdge): boolean =>
    edge.closesLoop === true && loopEdges.has(edge);

  // A node with self-loops is laid out as a box that holds the node and its
  // loops, with the node in the middle. So the node stays in line with the
  // nodes it has edges to.
  const loopPlans = planLoops(nodes, selfLoops);
  const computeLayoutBoxSize = (node: LayoutNode): Size => {
    const outermost = loopPlans.get(node.id)?.at(-1);
    if (outermost === undefined) return node;
    const room = outermost.rise + (outermost.edge.label?.height ?? 0) / 2;
    return {
      width: node.width + 2 * outermost.turnOffset,
      height: node.height + 2 * room,
    };
  };

  // A multigraph, because two edges can connect the same two nodes.
  const graph = new graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: true });
  graph.setGraph({
    rankdir: "LR",
    nodesep: NODE_GAP,
    ranksep: RANK_GAP,
    edgesep: EDGE_GAP,
    marginx: 0,
    marginy: 0,
  });
  for (const node of nodes) graph.setNode(node.id, { ...computeLayoutBoxSize(node) });
  for (const edge of routedEdges) {
    const [from, to] = isDrawnBackwards(edge) ? [edge.to, edge.from] : [edge.from, edge.to];
    graph.setEdge(
      from,
      to,
      edge.label === undefined ? {} : { ...edge.label, labelpos: "c" },
      edge.id,
    );
  }
  try {
    layout(graph);
  } catch {
    // dagre's search for a node order with few edge crossings can give two
    // nodes in the same rank the same position when three edges connect the
    // same two nodes, and dagre then throws (seen in @dagrejs/dagre 3.1.1).
    // dagre writes to the graph only when a layout completes, so the layout
    // is run again without that search, using dagre's initial node order.
    layout(graph, { disableOptimalOrderHeuristic: true });
  }

  // dagre sets a centre on every node and points on every edge, and every
  // edge connects two known nodes. So the non-null assertions below are safe.
  const centres = new Map<string, Point>();
  for (const node of nodes) {
    const { x, y } = graph.node(node.id);
    centres.set(node.id, { x: x!, y: y! });
  }
  // dagre centres the nodes of a rank on the rank's centre line. They are
  // moved to share the left edge of the rank's widest node instead, so the
  // edges into a rank's nodes are all as long as each other. The left edge
  // of each rank is keyed by the x of the rank's centre line.
  const rankLefts = new Map<number, number>();
  for (const node of nodes) {
    const { x } = centres.get(node.id)!;
    const left = x - computeLayoutBoxSize(node).width / 2;
    rankLefts.set(x, Math.min(rankLefts.get(x) ?? left, left));
  }
  const layoutBoxes = new Map<string, Box>();
  const cards = new Map<string, Box>();
  for (const node of nodes) {
    const centre = centres.get(node.id)!;
    const size = computeLayoutBoxSize(node);
    const box = { x: rankLefts.get(centre.x)!, y: centre.y - size.height / 2, ...size };
    layoutBoxes.set(node.id, box);
    // A card sits in the middle of its layout box, which also holds its self-loops.
    cards.set(node.id, {
      x: box.x + (box.width - node.width) / 2,
      y: centre.y - node.height / 2,
      width: node.width,
      height: node.height,
    });
  }

  const routes = new Map<string, EdgeRoute>();
  const labels: Array<Box> = [];
  const placeLabel = (edge: LayoutEdge, centre: Point): Point | undefined => {
    if (edge.label === undefined) return undefined;
    labels.push(buildCentredBox(centre, edge.label));
    return centre;
  };

  const drawnEdges = routedEdges.map((edge) => {
    const isBackwards = isDrawnBackwards(edge);
    const drawn = graph.edge(
      isBackwards ? edge.to : edge.from,
      isBackwards ? edge.from : edge.to,
      edge.id,
    );
    const label =
      drawn.x === undefined || drawn.y === undefined
        ? undefined
        : placeLabel(edge, { x: drawn.x, y: drawn.y });
    // dagre's points start at the node it was given as the source, so a
    // reversed edge's points are reversed back.
    const points = isBackwards ? [...drawn.points!].reverse() : drawn.points!;
    // 1 when the edge runs from left to right, -1 when it runs back.
    const direction = Math.sign(points.at(-1)!.x - points[0]!.x);
    return { edge, points, label, direction };
  });

  // Edges that attach to the same side of a card are spread evenly along it,
  // clear of the margin at each end. So no two edges meet the card at the
  // same point, and no arrowhead lands on a corner.
  // - They are sorted top to bottom by where each edge runs next to the card,
  //   so they do not cross there.
  // - A self-loop runs over the top of the card, so it attaches above the
  //   other edges. An inner loop attaches above an outer loop, which turns
  //   further out.
  const sides = new Map<
    string,
    { readonly card: Box; readonly attachments: Array<SideAttachment> }
  >();
  const attach = (nodeId: string, side: number, attachment: SideAttachment): void => {
    const key = `${String(side)} ${nodeId}`;
    const found = sides.get(key) ?? { card: cards.get(nodeId)!, attachments: [] };
    found.attachments.push(attachment);
    sides.set(key, found);
  };
  for (const [id, plans] of loopPlans) {
    for (const [index, { edge }] of plans.entries()) {
      attach(id, 1, { key: `start ${edge.id}`, order: [0, index] });
      attach(id, -1, { key: `end ${edge.id}`, order: [0, index] });
    }
  }
  // The dagre point next to each end shows where the edge runs next to the
  // card, because the edge crosses each rank at dagre's point.
  for (const { edge, points, direction } of drawnEdges) {
    attach(edge.from, direction, { key: `start ${edge.id}`, order: [1, points[1]!.y] });
    attach(edge.to, -direction, { key: `end ${edge.id}`, order: [1, points.at(-2)!.y] });
  }
  const attachmentYs = new Map<string, number>();
  for (const { card, attachments } of sides.values()) {
    attachments.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
    const span = card.height - 2 * sideMargin;
    for (const [index, { key: attachmentKey }] of attachments.entries()) {
      attachmentYs.set(
        attachmentKey,
        attachments.length === 1
          ? card.y + card.height / 2
          : card.y + sideMargin + (span * index) / (attachments.length - 1),
      );
    }
  }

  // Half the width of each rank, keyed by the x of the rank's centre line.
  // dagre centres every node, label and edge point of a rank on that line, so
  // a rank is as wide as its widest node or label.
  const rankHalfWidths = new Map<number, number>();
  for (const node of nodes) {
    const { x } = centres.get(node.id)!;
    rankHalfWidths.set(
      x,
      Math.max(rankHalfWidths.get(x) ?? 0, computeLayoutBoxSize(node).width / 2),
    );
  }
  for (const { edge, label } of drawnEdges) {
    if (label === undefined || edge.label === undefined) continue;
    rankHalfWidths.set(label.x, Math.max(rankHalfWidths.get(label.x) ?? 0, edge.label.width / 2));
  }

  // Returns the point where an edge end attaches on a card's left side
  // (`side` < 0) or right side (`side` > 0).
  const findHandle = (id: string, side: number, attachmentKey: string): Point => {
    const card = cards.get(id)!;
    return { x: card.x + (side > 0 ? card.width : 0), y: attachmentYs.get(attachmentKey)! };
  };

  // dagre keeps the nodes and labels of a rank apart, and leaves the space
  // between two ranks empty. So an edge that crosses each rank horizontally
  // at dagre's point, and turns only between ranks, never runs through a
  // node or label. At each end, the edge runs horizontally out of the card's
  // side, far enough to meet the side at a right angle.
  for (const { edge, points, label, direction } of drawnEdges) {
    // Returns the point, level with the handle, where the edge leaves the
    // node's rank: the rank's side, but at least `STRAIGHT_RUN` from the card.
    const findRankSide = (id: string, side: number, handle: Point): Point => {
      const centre = centres.get(id)!;
      const card = cards.get(id)!;
      const halfWidth = rankHalfWidths.get(centre.x)!;
      return {
        x:
          side > 0
            ? Math.max(centre.x + halfWidth, card.x + card.width + STRAIGHT_RUN)
            : Math.min(centre.x - halfWidth, card.x - STRAIGHT_RUN),
        y: handle.y,
      };
    };
    // Returns the points that take the edge horizontally across a rank. Each
    // point is repeated, so the curve is already horizontal when it reaches
    // the rank.
    const routeAcrossRank = (point: Point): ReadonlyArray<Point> => {
      const halfWidth = rankHalfWidths.get(point.x) ?? 0;
      return halfWidth === 0
        ? [point]
        : [
            { x: point.x - direction * halfWidth, y: point.y },
            { x: point.x - direction * halfWidth, y: point.y },
            { x: point.x + direction * halfWidth, y: point.y },
            { x: point.x + direction * halfWidth, y: point.y },
          ];
    };
    const start = findHandle(edge.from, direction, `start ${edge.id}`);
    const end = findHandle(edge.to, -direction, `end ${edge.id}`);
    routes.set(edge.id, {
      points: [
        start,
        findRankSide(edge.from, direction, start),
        ...points.slice(1, -1).flatMap(routeAcrossRank),
        findRankSide(edge.to, -direction, end),
        end,
      ],
      ...(label === undefined ? {} : { label }),
    });
  }

  for (const [id, plans] of loopPlans) {
    const card = cards.get(id)!;
    for (const { edge, turnOffset, rise } of plans) {
      const overpassY = card.y - rise;
      const label = placeLabel(edge, { x: card.x + card.width / 2, y: overpassY });
      routes.set(edge.id, {
        points: routeLoopOverCard(
          findHandle(id, 1, `start ${edge.id}`),
          findHandle(id, -1, `end ${edge.id}`),
          overpassY,
          turnOffset,
        ),
        ...(label === undefined ? {} : { label }),
      });
    }
  }

  // Move the drawing so its bounding box starts at the origin.
  const bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const extents: Array<Box> = [
    ...layoutBoxes.values(),
    ...labels,
    ...[...routes.values()].flatMap((route) =>
      route.points.map((point) => ({ ...point, width: 0, height: 0 })),
    ),
  ];
  for (const box of extents) {
    bounds.minX = Math.min(bounds.minX, box.x);
    bounds.minY = Math.min(bounds.minY, box.y);
    bounds.maxX = Math.max(bounds.maxX, box.x + box.width);
    bounds.maxY = Math.max(bounds.maxY, box.y + box.height);
  }
  const { minX, minY, maxX, maxY } = bounds;
  const moveToOrigin = (point: Point): Point => ({ x: point.x - minX, y: point.y - minY });
  return {
    nodes: new Map([...cards].map(([id, card]) => [id, moveToOrigin(card)])),
    edges: new Map(
      [...routes].map(([id, route]) => [
        id,
        {
          points: route.points.map(moveToOrigin),
          ...(route.label === undefined ? {} : { label: moveToOrigin(route.label) }),
        },
      ]),
    ),
    size: { width: maxX - minX, height: maxY - minY },
  };
};

/**
 * The smallest zoom at which a drawing's text is readable. At this zoom a
 * card's id, 12.5px, renders at about 9.4px, and its kind label, 10.5px, at
 * about 7.9px. A run's page never places its plan below it: the reader pans a
 * plan that does not fit at this zoom.
 */
export const LEGIBLE_ZOOM = 0.75;

/**
 * The smallest zoom the reader can zoom out to, and the smallest at which the
 * workflow editor places a drawing. The editor always shows the whole
 * workflow when it opens, because the author is looking at the workflow's
 * shape; the author zooms in to read a part of it.
 */
export const MIN_ZOOM = 0.25;

/**
 * The largest zoom for automatic placement and for "Fit to view". A small
 * drawing is scaled above the legible zoom so it does not look lost in a
 * large pane, but not above this, so its cards stay in scale with the text
 * next to the graph.
 */
export const LARGEST_PLACED_ZOOM = 1.25;

/** The margin between the pane's edge and the drawing. */
const PANE_MARGIN = 16;

/**
 * Returns the zoom a drawing is placed at, given the largest zoom at which it
 * fits: that zoom, but never above `LARGEST_PLACED_ZOOM` and never below
 * `smallestZoom`.
 */
const computePlacedZoom = (fittingZoom: number, smallestZoom: number): number =>
  Math.min(LARGEST_PLACED_ZOOM, Math.max(smallestZoom, fittingZoom));

/**
 * The room above and below a drawing in a pane sized to it. The "Fit to view"
 * control sits in the pane's bottom-right corner, 8px from its edges and 28px
 * high, so a drawing centred with this room above and below never runs under
 * it.
 */
const FIT_CONTROL_ROOM = 40;

/**
 * Computes the height of a pane `paneWidth` wide that shows a whole drawing,
 * between `min` and `max`.
 *
 * The drawing is placed at the zoom at which it fills the pane's width, as
 * `computeDrawingViewport` places it, and the pane is as tall as the drawing
 * at that zoom plus `FIT_CONTROL_ROOM` above and below. A pane that is not
 * yet measured has an infinite width, which gives the drawing its largest
 * zoom. A drawing too wide to fit at the legible zoom is sized at the legible
 * zoom, and the reader pans to see the rest.
 */
export const computePaneHeight = (
  paneWidth: number,
  drawing: Size,
  { min, max }: { readonly min: number; readonly max: number },
): number => {
  const zoom = computePlacedZoom((paneWidth - 2 * PANE_MARGIN) / drawing.width, LEGIBLE_ZOOM);
  return Math.min(max, Math.max(min, Math.ceil(drawing.height * zoom + 2 * FIT_CONTROL_ROOM)));
};

/** A viewport: the offset of the drawing's origin in the pane, and the zoom. */
export interface DrawingViewport extends Point {
  readonly zoom: number;
}

/**
 * Computes the viewport for a drawing that the author has not panned or
 * zoomed.
 *
 * The zoom is the largest one, up to `LARGEST_PLACED_ZOOM`, at which the
 * drawing fits the pane with a margin, but never below `smallestZoom`. On
 * each axis, a drawing that fits at that zoom is centred. A drawing that does
 * not fit starts at the pane's top or left edge, where the triggers are, and
 * the reader pans to see the rest.
 */
export const computeDrawingViewport = (
  pane: Size,
  drawing: Size,
  smallestZoom: number,
): DrawingViewport => {
  const zoom = computePlacedZoom(
    Math.min(
      (pane.width - 2 * PANE_MARGIN) / drawing.width,
      (pane.height - 2 * PANE_MARGIN) / drawing.height,
    ),
    smallestZoom,
  );
  const findOffset = (paneSize: number, drawingSize: number): number => {
    const scaledSize = drawingSize * zoom;
    return scaledSize + 2 * PANE_MARGIN <= paneSize ? (paneSize - scaledSize) / 2 : PANE_MARGIN;
  };
  return {
    x: findOffset(pane.width, drawing.width),
    y: findOffset(pane.height, drawing.height),
    zoom,
  };
};
