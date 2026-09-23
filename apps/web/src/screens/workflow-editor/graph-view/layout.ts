/**
 * Lays a graph out from left to right, in ranks. This file is the one place
 * that imports the layout engine, so the engine can be replaced here alone.
 *
 * The engine places the nodes and the labels, and routes each edge through
 * points of its own, with room for each label. An edge leaves its source at
 * the middle of the side of the source that its route leaves, and enters its
 * target at the middle of the side that its route enters, where the cards'
 * handles are, so an arrow never lands on a corner. An edge from a node to
 * itself is not the engine's: it runs out of the node to the right, over the
 * top of the node, and into the node from the left.
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

/** A node to place, with the size it is drawn at. */
interface LayoutNode extends Size {
  readonly id: string;
}

/** An edge to route, with the size of its label if it has one, so the label gets room. */
interface LayoutEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly label?: Size;
  /**
   * Whether the edge goes back to the start of a loop. The layout draws such
   * an edge from right to left, so that the rest of the loop reads from left
   * to right. An edge that is on no loop goes forward all the same.
   */
  readonly closesLoop?: boolean;
}

/**
 * Where an edge runs: the points that its curve follows, and the centre of
 * its label. The curve is the smooth curve that the layout engine's own
 * renderer draws through such points. It starts at the first point and ends
 * at the last, and between them it passes near each point. A point that is
 * given twice is a corner that the curve turns close to.
 */
export interface EdgeRoute {
  readonly points: ReadonlyArray<Point>;
  readonly label?: Point;
}

interface GraphLayout {
  /** The top-left corner of each node, by the node's id. */
  readonly nodes: ReadonlyMap<string, Point>;
  /** The route of each edge, by the edge's id. */
  readonly edges: ReadonlyMap<string, EdgeRoute>;
  /** The size of the box that holds every node, edge and label, from the origin. */
  readonly size: Size;
}

/** The space between two nodes of one rank. */
const NODE_GAP = 20;

/** The space between two ranks. An edge label takes a rank of its own between them. */
const RANK_GAP = 40;

/** The space between two edges that run side by side. */
const EDGE_GAP = 12;

/**
 * How far an edge runs straight out of its source and straight into its
 * target, so that it meets each side at a right angle.
 */
const STRAIGHT_RUN = 8;

/** How far to the side of its node a loop from the node to itself turns up and down. */
const TURN_OFFSET = 16;

/**
 * The space between the top of a node and the line of a loop from the node
 * to itself. The label sits on the line, so the space holds half of a label
 * and a gap below it.
 */
const LOOP_RISE = 24;

/** The space between the label of a loop from a node to itself and the loop's turns up and down. */
const LABEL_CLEARANCE = 8;

/** A box on the drawing: its left and top edges, and its size. */
interface Box extends Point, Size {}

/** The box of a label or a node of some size, around its centre. */
const buildCentredBox = (centre: Point, size: Size): Box => ({
  x: centre.x - size.width / 2,
  y: centre.y - size.height / 2,
  ...size,
});

/**
 * The edges that are on a loop: an edge is on a loop when a way leads from
 * its target back to its source.
 */
const findLoopEdges = (edges: ReadonlyArray<LayoutEdge>): ReadonlySet<LayoutEdge> => {
  const successors = new Map<string, Array<string>>();
  for (const edge of edges)
    successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to]);
  const leadsTo = (start: string, goal: string): boolean => {
    const reached = new Set([start]);
    // The set grows while it is walked, and a walk of a set visits what is
    // added behind the walk too, so this is a breadth-first search.
    for (const id of reached) {
      if (id === goal) return true;
      for (const next of successors.get(id) ?? []) reached.add(next);
    }
    return false;
  };
  return new Set(edges.filter((edge) => leadsTo(edge.to, edge.from)));
};

/**
 * The route of a loop from the right side of `card` to its left side, along
 * the line at `overpassY` above it. The loop turns up and down `turnOffset`
 * to the side of the card.
 */
const routeLoopOverCard = (
  card: Box,
  overpassY: number,
  turnOffset: number,
): ReadonlyArray<Point> => {
  const start = { x: card.x + card.width, y: card.y + card.height / 2 };
  const end = { x: card.x, y: start.y };
  const corners = [
    { x: start.x + turnOffset, y: start.y },
    { x: start.x + turnOffset, y: overpassY },
    { x: end.x - turnOffset, y: overpassY },
    { x: end.x - turnOffset, y: end.y },
  ];
  return [start, ...corners.flatMap((corner) => [corner, corner]), end];
};

/** Where a loop from a node to itself runs, from the top of the node. */
interface LoopPlan {
  readonly edge: LayoutEdge;
  /** How far to the side of the node the loop turns up and down. */
  readonly turnOffset: number;
  /** How far above the top of the node the loop runs. */
  readonly rise: number;
}

/**
 * Where each loop of each node runs. A node's loops stack above it, each one
 * above the label of the loop below it, and each one wider than the loop
 * below it, so that no loop crosses the label or the turns of another. A loop
 * is wide enough for its label to sit on it between its two turns.
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
 * Places each node and routes each edge. An edge that closes a loop is given
 * to the engine the other way round, so the engine ranks it as the edge that
 * goes back. An edge from a node to itself is given room above its node.
 */
export const computeGraphLayout = (
  nodes: ReadonlyArray<LayoutNode>,
  edges: ReadonlyArray<LayoutEdge>,
): GraphLayout => {
  const selfLoops = edges.filter((edge) => edge.from === edge.to);
  const routedEdges = edges.filter((edge) => edge.from !== edge.to);
  const loopEdges = findLoopEdges(routedEdges);
  const isDrawnBackwards = (edge: LayoutEdge): boolean =>
    edge.closesLoop === true && loopEdges.has(edge);

  // A node with loops is laid out as a box that holds the node and its loops,
  // with the node in its middle, so that the node stays in line with the
  // nodes that it has edges with.
  const loopPlans = planLoops(nodes, selfLoops);
  const sizeLayoutBox = (node: LayoutNode): Size => {
    const outermost = loopPlans.get(node.id)?.at(-1);
    if (outermost === undefined) return node;
    const room = outermost.rise + (outermost.edge.label?.height ?? 0) / 2;
    return {
      width: node.width + 2 * outermost.turnOffset,
      height: node.height + 2 * room,
    };
  };

  // A multigraph, because two edges may join the same two nodes.
  const graph = new graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: true });
  graph.setGraph({
    rankdir: "LR",
    nodesep: NODE_GAP,
    ranksep: RANK_GAP,
    edgesep: EDGE_GAP,
    marginx: 0,
    marginy: 0,
  });
  for (const node of nodes) graph.setNode(node.id, { ...sizeLayoutBox(node) });
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
    // The engine's search for an order of the nodes of each rank with few
    // crossings can give two nodes of one rank the same place when three
    // edges join the same two nodes, and the engine then throws (seen in
    // @dagrejs/dagre 3.1.1). The engine changes the graph only when a layout
    // ends, so the layout is made again, without that search, in the order
    // that the engine starts from.
    layout(graph, { disableOptimalOrderHeuristic: true });
  }

  // The engine gives a centre to each node and points to each edge that it
  // lays out, and each edge joins two of the nodes, so the reads below that
  // assert a value never read one that is absent.
  const centres = new Map<string, Point>();
  const layoutBoxes = new Map<string, Box>();
  const cards = new Map<string, Box>();
  for (const node of nodes) {
    const { x, y } = graph.node(node.id);
    const centre = { x: x!, y: y! };
    centres.set(node.id, centre);
    layoutBoxes.set(node.id, buildCentredBox(centre, sizeLayoutBox(node)));
    cards.set(node.id, buildCentredBox(centre, node));
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
    // The engine's points run from the node that it was given first.
    const points = isBackwards ? [...drawn.points!].reverse() : drawn.points!;
    return { edge, points, label };
  });

  // Half the width of each rank, by the line through the rank's middle. The
  // engine centres each node, each label and each point of an edge in its
  // rank on that line, so the rank is as wide as its widest node or label.
  const rankHalfWidths = new Map<number, number>();
  for (const node of nodes) {
    const { x } = centres.get(node.id)!;
    rankHalfWidths.set(x, Math.max(rankHalfWidths.get(x) ?? 0, sizeLayoutBox(node).width / 2));
  }
  for (const { edge, label } of drawnEdges) {
    if (label === undefined || edge.label === undefined) continue;
    rankHalfWidths.set(label.x, Math.max(rankHalfWidths.get(label.x) ?? 0, edge.label.width / 2));
  }

  // The engine keeps the nodes and the labels of a rank apart, and leaves the
  // space between two ranks free. So an edge that crosses each rank level, at
  // the engine's point, and turns only between ranks, never runs through a
  // node or a label. At each end it runs level out of the middle of the
  // card's side, far enough to meet the side at a right angle.
  for (const { edge, points, label } of drawnEdges) {
    // 1 where the edge runs from left to right, and -1 where it runs back.
    const direction = Math.sign(points.at(-1)!.x - points[0]!.x);
    // The middle of the side of a node's card that faces `side`, and the
    // point level with it where the edge leaves the node's rank.
    const findHandle = (id: string, side: number): Point => {
      const centre = centres.get(id)!;
      return { x: centre.x + (side * cards.get(id)!.width) / 2, y: centre.y };
    };
    const findRankSide = (id: string, side: number): Point => {
      const centre = centres.get(id)!;
      const reach = Math.max(
        rankHalfWidths.get(centre.x)!,
        cards.get(id)!.width / 2 + STRAIGHT_RUN,
      );
      return { x: centre.x + side * reach, y: centre.y };
    };
    // Each point is given twice, so that the curve is level before it
    // reaches the rank.
    const crossRank = (point: Point): ReadonlyArray<Point> => {
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
    routes.set(edge.id, {
      points: [
        findHandle(edge.from, direction),
        findRankSide(edge.from, direction),
        ...points.slice(1, -1).flatMap(crossRank),
        findRankSide(edge.to, -direction),
        findHandle(edge.to, -direction),
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
        points: routeLoopOverCard(card, overpassY, turnOffset),
        ...(label === undefined ? {} : { label }),
      });
    }
  }

  // The drawing is moved so that the box that holds all of it starts at the
  // origin.
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
 * The smallest zoom that a drawing is placed at by itself. The kind of a card
 * is set at 10.5 px, the smallest size of the type scale, so a smaller zoom
 * would draw it smaller than the type scale allows.
 */
const LEGIBLE_ZOOM = 1;

/**
 * The largest zoom that a drawing is placed or fitted at. A small drawing is
 * drawn larger than the legible zoom, so that it does not look lost in a
 * large pane. It is not drawn larger than this, so that its cards stay in
 * scale with the text beside the graph.
 */
export const LARGEST_PLACED_ZOOM = 1.25;

/** The space between the pane's edge and the drawing. */
const PANE_MARGIN = 16;

/** Where a drawing sits in a pane: the offset of its origin, and its zoom. */
export interface DrawingPlace extends Point {
  readonly zoom: number;
}

/**
 * Where a drawing goes in a pane when the author has not moved it. The zoom
 * is the largest zoom up to `LARGEST_PLACED_ZOOM` at which the drawing fits
 * the pane with a margin, and never less than the legible zoom. On each axis,
 * a drawing that fits the pane at that zoom is centred in it, and a larger
 * one starts at the pane's edge, where the triggers are, and the author pans
 * to the rest.
 */
export const placeDrawing = (pane: Size, drawing: Size): DrawingPlace => {
  const fittingZoom = Math.min(
    (pane.width - 2 * PANE_MARGIN) / drawing.width,
    (pane.height - 2 * PANE_MARGIN) / drawing.height,
  );
  const zoom = Math.min(LARGEST_PLACED_ZOOM, Math.max(LEGIBLE_ZOOM, fittingZoom));
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
