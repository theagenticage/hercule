/**
 * The layout must satisfy these rules:
 * - The graph reads from left to right.
 * - Each edge leaves a side of its source and enters a side of its target, at
 *   its own point, clear of the corners.
 * - Everything drawn is inside the layout's size.
 * - No route runs through a node, or through another edge's label.
 */
import { describe, expect, it } from "vitest";
import {
  computeDrawingViewport,
  computeGraphLayout,
  LARGEST_PLACED_ZOOM,
  type EdgeRoute,
  type Point,
  type Size,
} from "./layout";

const CARD: Size = { width: 144, height: 52 };
const LABEL: Size = { width: 120, height: 20 };
/** The length at each end of a card's side where no edge attaches. */
const SIDE_MARGIN = 14;

type Layout = ReturnType<typeof computeGraphLayout>;
type LayoutEdges = Parameters<typeof computeGraphLayout>[1];

/** A rectangle in the drawing. */
type Box = Point & Size;

const buildNodes = (...ids: ReadonlyArray<string>) => ids.map((id) => ({ id, ...CARD }));

const readNode = (layout: Layout, id: string): Point => {
  const node = layout.nodes.get(id);
  if (node === undefined) throw new Error(`The layout places no node ${id}.`);
  return node;
};

const readRoute = (layout: Layout, id: string): EdgeRoute => {
  const route = layout.edges.get(id);
  if (route === undefined) throw new Error(`The layout routes no edge ${id}.`);
  return route;
};

/** Returns true when two rectangles overlap. */
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Builds the rectangle of a label centred on a point. */
const buildLabelBox = (centre: Point, size: Size = LABEL): Box => ({
  x: centre.x - size.width / 2,
  y: centre.y - size.height / 2,
  ...size,
});

/** Returns true when the straight line from `from` to `to` passes through the inside of a rectangle. */
const crossesBox = (from: Point, to: Point, box: Box): boolean => {
  for (let step = 0; step <= 100; step += 1) {
    const x = from.x + ((to.x - from.x) * step) / 100;
    const y = from.y + ((to.y - from.y) * step) / 100;
    if (x > box.x + 1 && x < box.x + box.width - 1 && y > box.y + 1 && y < box.y + box.height - 1) {
      return true;
    }
  }
  return false;
};

/**
 * Checks that a layout is clear:
 * - every node, route point and label is inside the layout's size,
 * - no label covers a node or another label,
 * - no route runs through a node or another edge's label,
 * - no two edges meet a card at the same point.
 */
const expectClearDrawing = (layout: Layout, edges: LayoutEdges): void => {
  const { width, height } = layout.size;
  const isInside = (box: Box) =>
    box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height;
  const cards = [...layout.nodes].map(([id, node]) => ({ id, box: { ...node, ...CARD } }));
  const labels = edges.flatMap((edge) => {
    const centre = readRoute(layout, edge.id).label;
    return edge.label === undefined || centre === undefined
      ? []
      : [{ id: edge.id, box: buildLabelBox(centre, edge.label) }];
  });
  for (const card of cards) expect(isInside(card.box), `node ${card.id}`).toBe(true);
  for (const [index, label] of labels.entries()) {
    expect(isInside(label.box), `the label of ${label.id}`).toBe(true);
    for (const card of cards) {
      expect(overlaps(label.box, card.box), `the label of ${label.id} on ${card.id}`).toBe(false);
    }
    for (const other of labels.slice(index + 1)) {
      expect(overlaps(label.box, other.box), `the labels of ${label.id} and ${other.id}`).toBe(
        false,
      );
    }
  }
  const ends = edges.flatMap((edge) => {
    const { points } = readRoute(layout, edge.id);
    return [points[0], points.at(-1)].map((point) => `${String(point?.x)},${String(point?.y)}`);
  });
  expect(new Set(ends).size, "the points where the edges meet the cards").toBe(ends.length);
  for (const edge of edges) {
    const { points } = readRoute(layout, edge.id);
    for (const point of points) {
      expect(isInside({ ...point, width: 0, height: 0 }), `a point of ${edge.id}`).toBe(true);
    }
    for (const [index, point] of points.slice(1).entries()) {
      const previous = points[index]!;
      for (const card of cards) {
        expect(crossesBox(previous, point, card.box), `${edge.id} through ${card.id}`).toBe(false);
      }
      for (const label of labels.filter((other) => other.id !== edge.id)) {
        expect(
          crossesBox(previous, point, label.box),
          `${edge.id} through the label of ${label.id}`,
        ).toBe(false);
      }
    }
  }
};

/** Returns true when a point is on a card's left or right side, clear of the margin at each end. */
const isOnSide = (point: Point | undefined, card: Point, side: "left" | "right"): boolean =>
  point !== undefined &&
  point.x === card.x + (side === "right" ? CARD.width : 0) &&
  point.y >= card.y + SIDE_MARGIN &&
  point.y <= card.y + CARD.height - SIDE_MARGIN;

/**
 * Checks that an edge's route starts on a side of the source and ends on a
 * side of the target, clear of the corners, and meets each side at a right
 * angle. `forward` means the edge leaves the source's right side and enters
 * the target's left side. `back` means the opposite.
 */
const expectHandleToHandle = (
  layout: Layout,
  id: string,
  from: string,
  to: string,
  direction: "forward" | "back" = "forward",
): void => {
  const { points } = readRoute(layout, id);
  const isForward = direction === "forward";
  const [first, second] = points;
  const [beforeLast, last] = points.slice(-2);
  expect(isOnSide(first, readNode(layout, from), isForward ? "right" : "left"), id).toBe(true);
  expect(isOnSide(last, readNode(layout, to), isForward ? "left" : "right"), id).toBe(true);
  expect(second?.y).toBe(first?.y);
  expect(Math.sign((second?.x ?? 0) - (first?.x ?? 0))).toBe(isForward ? 1 : -1);
  expect(beforeLast?.y).toBe(last?.y);
  expect(Math.sign((last?.x ?? 0) - (beforeLast?.x ?? 0))).toBe(isForward ? 1 : -1);
};

/** Creates a seeded random number generator that returns numbers from 0 to 1. */
const createRandom = (seed: number) => {
  let state = seed;
  return (): number => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
};

describe("computeGraphLayout", () => {
  it("places the nodes from left to right along the edges, inside the size", () => {
    const edges = [
      { id: "e0", from: "start", to: "open_task" },
      { id: "e1", from: "open_task", to: "review" },
    ];
    const layout = computeGraphLayout(
      buildNodes("start", "open_task", "review"),
      edges,
      SIDE_MARGIN,
    );

    expect(readNode(layout, "start").x + CARD.width).toBeLessThan(readNode(layout, "open_task").x);
    expect(readNode(layout, "open_task").x + CARD.width).toBeLessThan(readNode(layout, "review").x);
    expectHandleToHandle(layout, "e0", "start", "open_task");
    expectHandleToHandle(layout, "e1", "open_task", "review");
    expectClearDrawing(layout, edges);
  });

  it("puts a label between the two ends of its edge, on the edge's route", () => {
    const edges = [{ id: "e0", from: "review", to: "comment", label: LABEL }];
    const layout = computeGraphLayout(buildNodes("review", "comment"), edges, SIDE_MARGIN);
    const route = readRoute(layout, "e0");
    const labelBox = buildLabelBox(route.label ?? { x: -Infinity, y: -Infinity });

    expect(labelBox.x).toBeGreaterThanOrEqual(readNode(layout, "review").x + CARD.width);
    expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(readNode(layout, "comment").x);
    // The route runs horizontally through the label, so the label sits on the line.
    expect(route.points).toContainEqual({ x: labelBox.x, y: route.label?.y });
    expect(route.points).toContainEqual({ x: labelBox.x + labelBox.width, y: route.label?.y });
    expectClearDrawing(layout, edges);
  });

  it("draws an edge from a node to itself as a loop over the node, clear of the node above it", () => {
    // Two nodes share a rank, so another node sits above the node with the loop.
    const edges = [
      { id: "e0", from: "labelled", to: "review" },
      { id: "e1", from: "nightly", to: "review" },
      { id: "loop", from: "nightly", to: "nightly", label: LABEL },
    ];
    const layout = computeGraphLayout(
      buildNodes("labelled", "nightly", "review"),
      edges,
      SIDE_MARGIN,
    );
    const nightly = readNode(layout, "nightly");
    const loop = readRoute(layout, "loop");

    expectHandleToHandle(layout, "loop", "nightly", "nightly");
    // The loop runs over the top of its node, and its label sits on it.
    expect(Math.min(...loop.points.map((point) => point.y))).toBeLessThan(nightly.y);
    expect(loop.label?.y).toBeLessThan(nightly.y);
    expectClearDrawing(layout, edges);
  });

  it("spaces two self-loops of one node apart, each clear of the other's label", () => {
    const edges = [
      { id: "inner", from: "poll", to: "poll", label: LABEL },
      { id: "outer", from: "poll", to: "poll", label: LABEL },
    ];
    const layout = computeGraphLayout(buildNodes("poll"), edges, SIDE_MARGIN);
    const [inner, outer] = [readRoute(layout, "inner"), readRoute(layout, "outer")];

    expect(Math.min(...outer.points.map((point) => point.y))).toBeLessThan(
      Math.min(...inner.points.map((point) => point.y)) - LABEL.height / 2,
    );
    expect(Math.max(...outer.points.map((point) => point.x))).toBeGreaterThan(
      Math.max(...inner.points.map((point) => point.x)),
    );
    expectClearDrawing(layout, edges);
  });

  it("draws the edge that closes a loop from right to left, out of its source's left side and into its target's right side", () => {
    const edges = [
      { id: "e0", from: "implement", to: "open_pr" },
      { id: "e1", from: "open_pr", to: "review" },
      { id: "back", from: "review", to: "implement", label: LABEL, closesLoop: true },
    ];
    const layout = computeGraphLayout(
      buildNodes("implement", "open_pr", "review"),
      edges,
      SIDE_MARGIN,
    );

    expect(readNode(layout, "implement").x).toBeLessThan(readNode(layout, "open_pr").x);
    expect(readNode(layout, "open_pr").x).toBeLessThan(readNode(layout, "review").x);
    expectHandleToHandle(layout, "back", "review", "implement", "back");
    expectHandleToHandle(layout, "e0", "implement", "open_pr");
    expectHandleToHandle(layout, "e1", "open_pr", "review");
    expectClearDrawing(layout, edges);
  });

  it("attaches two edges on one side of a card at separate points, clear of the corners", () => {
    const edges = [
      { id: "forward", from: "implement", to: "review" },
      { id: "back", from: "review", to: "implement", label: LABEL, closesLoop: true },
    ];
    const layout = computeGraphLayout(buildNodes("implement", "review"), edges, SIDE_MARGIN);
    const [forward, back] = [readRoute(layout, "forward").points, readRoute(layout, "back").points];
    // Both edges attach to the right side of implement and to the left side of review.
    const atImplement = [forward[0], back.at(-1)];
    const atReview = [forward.at(-1), back[0]];

    for (const point of atImplement) {
      expect(isOnSide(point, readNode(layout, "implement"), "right")).toBe(true);
    }
    for (const point of atReview) {
      expect(isOnSide(point, readNode(layout, "review"), "left")).toBe(true);
    }
    expect(atImplement[0]?.y).not.toBe(atImplement[1]?.y);
    expect(atReview[0]?.y).not.toBe(atReview[1]?.y);
    // The edge that is higher at one card is higher at the other, so the two do not cross.
    expect(Math.sign((atImplement[0]?.y ?? 0) - (atImplement[1]?.y ?? 0))).toBe(
      Math.sign((atReview[0]?.y ?? 0) - (atReview[1]?.y ?? 0)),
    );
    expectClearDrawing(layout, edges);
  });

  it("draws the edge that closes a loop backwards, regardless of the order of nodes and edges", () => {
    // A signal trigger into the loop's last step comes first in both lists.
    const edges = [
      { id: "signal", from: "rerun_review", to: "review" },
      { id: "back", from: "review", to: "implement", label: LABEL, closesLoop: true },
      { id: "e2", from: "open_pr", to: "review" },
      { id: "e1", from: "implement", to: "open_pr" },
      { id: "start", from: "assigned", to: "implement" },
    ];
    const layout = computeGraphLayout(
      buildNodes("rerun_review", "review", "open_pr", "implement", "assigned"),
      edges,
      SIDE_MARGIN,
    );
    const readX = (id: string) => readNode(layout, id).x;

    expect(readX("assigned")).toBeLessThan(readX("implement"));
    expect(readX("implement")).toBeLessThan(readX("open_pr"));
    expect(readX("open_pr")).toBeLessThan(readX("review"));
    expectHandleToHandle(layout, "back", "review", "implement", "back");
    expectClearDrawing(layout, edges);
  });

  it("draws an edge forward when it is not part of a loop, even if closesLoop is set", () => {
    const edges = [{ id: "e0", from: "open_task", to: "review", closesLoop: true }];
    const layout = computeGraphLayout(buildNodes("open_task", "review"), edges, SIDE_MARGIN);

    expect(readNode(layout, "open_task").x).toBeLessThan(readNode(layout, "review").x);
    expectHandleToHandle(layout, "e0", "open_task", "review");
  });

  it("routes two backward edges into the same node, each clear of the other's label", () => {
    const edges = [
      { id: "e0", from: "plan", to: "build" },
      { id: "e1", from: "build", to: "test" },
      { id: "e2", from: "test", to: "ship" },
      { id: "retry", from: "test", to: "plan", label: LABEL, closesLoop: true },
      { id: "redo", from: "ship", to: "plan", label: { width: 160, height: 20 }, closesLoop: true },
    ];
    const layout = computeGraphLayout(
      buildNodes("plan", "build", "test", "ship"),
      edges,
      SIDE_MARGIN,
    );

    expectHandleToHandle(layout, "retry", "test", "plan", "back");
    expectHandleToHandle(layout, "redo", "ship", "plan", "back");
    expect(readRoute(layout, "retry").label?.y).not.toBe(readRoute(layout, "redo").label?.y);
    expectClearDrawing(layout, edges);
  });

  it("lays out three edges between the same two nodes, which makes dagre's order search throw", () => {
    const edges = [
      { id: "e0", from: "b", to: "c", label: LABEL },
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "a", to: "c", label: LABEL },
      { id: "e3", from: "a", to: "b" },
      { id: "e4", from: "a", to: "b" },
    ];
    const layout = computeGraphLayout(buildNodes("a", "b", "c"), edges, SIDE_MARGIN);

    for (const id of ["e1", "e3", "e4"]) expectHandleToHandle(layout, id, "a", "b");
    expectClearDrawing(layout, edges);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    "keeps a graph of twelve nodes with loops and labels clear, sample %i",
    (seed) => {
      const random = createRandom(seed);
      const ids = Array.from({ length: 12 }, (_, index) => `n${String(index)}`);
      const pickLabel = (chance: number) =>
        random() < chance ? { label: { width: 50 + Math.floor(random() * 130), height: 20 } } : {};
      const edges: LayoutEdges = [
        ...ids.slice(1).map((id, index) => ({
          id: `line${String(index)}`,
          from: ids[index]!,
          to: id,
          ...pickLabel(0.5),
        })),
        ...Array.from({ length: 6 }, (_, index) => {
          const [from, to] = [Math.floor(random() * 12), Math.floor(random() * 12)];
          return {
            id: `extra${String(index)}`,
            from: ids[from]!,
            to: ids[to]!,
            closesLoop: to <= from,
            ...pickLabel(0.7),
          };
        }),
      ];
      const layout = computeGraphLayout(buildNodes(...ids), edges, SIDE_MARGIN);

      // The chain through every node goes from left to right, so the edges
      // back to an earlier node are the ones drawn backwards.
      for (const [index, id] of ids.slice(1).entries()) {
        expect(readNode(layout, ids[index]!).x).toBeLessThan(readNode(layout, id).x);
      }
      expectClearDrawing(layout, edges);
    },
  );
});

describe("computeDrawingViewport", () => {
  it("scales a small drawing up to the largest zoom, fits a wider one, and shows a large one at the legible zoom from the pane's edge", () => {
    const pane: Size = { width: 1200, height: 800 };

    // Three cards in a row fit the pane at the largest zoom, centred.
    const small: Size = { width: 520, height: 52 };
    expect(computeDrawingViewport(pane, small)).toEqual({
      x: (1200 - 520 * LARGEST_PLACED_ZOOM) / 2,
      y: (800 - 52 * LARGEST_PLACED_ZOOM) / 2,
      zoom: LARGEST_PLACED_ZOOM,
    });

    // A drawing that fits only slightly above the legible zoom gets the largest zoom that fits.
    const wide: Size = { width: 1052, height: 200 };
    expect(computeDrawingViewport(pane, wide).zoom).toBeCloseTo((1200 - 2 * 16) / 1052);

    // A drawing a little wider than the pane is scaled down until it fits:
    // five step cards of a run in the 258px-high pane of a run's page.
    const run: Size = { width: 1215, height: 52 };
    const runPane: Size = { width: 970, height: 258 };
    const fitted = computeDrawingViewport(runPane, run);
    expect(fitted.zoom).toBeCloseTo((970 - 2 * 16) / 1215);
    expect(fitted.x).toBeCloseTo(16);

    // A drawing that fits only at a smaller zoom gets the legible zoom and
    // starts at the pane's left edge. It is still centred vertically, where it fits.
    const large: Size = { width: 2000, height: 300 };
    expect(computeDrawingViewport(pane, large)).toEqual({
      x: 16,
      y: (800 - 300 * 0.75) / 2,
      zoom: 0.75,
    });
  });
});
