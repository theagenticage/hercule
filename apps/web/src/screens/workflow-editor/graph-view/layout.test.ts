/**
 * The layout of the graph: where each node goes, and where each edge and its
 * label run. The graph is read from left to right. Each edge leaves the middle
 * of a side of its source and enters the middle of a side of its target,
 * where the cards' handles are, and everything drawn is inside the size. No
 * route runs through a node, or through the label of another edge.
 */
import { describe, expect, it } from "vitest";
import {
  computeGraphLayout,
  LARGEST_PLACED_ZOOM,
  placeDrawing,
  type EdgeRoute,
  type Point,
  type Size,
} from "./layout";

const CARD: Size = { width: 144, height: 52 };
const LABEL: Size = { width: 120, height: 20 };

type Layout = ReturnType<typeof computeGraphLayout>;
type LayoutEdges = Parameters<typeof computeGraphLayout>[1];

/** A box on the drawing. */
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

/** Whether two boxes share any area. */
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The box of a label of some size around its centre. */
const buildLabelBox = (centre: Point, size: Size = LABEL): Box => ({
  x: centre.x - size.width / 2,
  y: centre.y - size.height / 2,
  ...size,
});

/** Whether the straight line from `from` to `to` passes through the inside of a box. */
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
 * Each node, point and label of a layout lies inside its size, no label
 * covers a node or another label, and no route runs through a node or the
 * label of another edge.
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

/**
 * The route of an edge starts at the middle of a side of the source and ends
 * at the middle of a side of the target, and it meets each side at a right
 * angle. `direction` is `forward` for an edge that leaves the source's right
 * side and enters the target's left side, and `back` for the other way.
 */
const expectHandleToHandle = (
  layout: Layout,
  id: string,
  from: string,
  to: string,
  direction: "forward" | "back" = "forward",
): void => {
  const { points } = readRoute(layout, id);
  const source = readNode(layout, from);
  const target = readNode(layout, to);
  const isForward = direction === "forward";
  const [first, second] = points;
  const [beforeLast, last] = points.slice(-2);
  expect(first).toEqual({
    x: source.x + (isForward ? CARD.width : 0),
    y: source.y + CARD.height / 2,
  });
  expect(last).toEqual({
    x: target.x + (isForward ? 0 : CARD.width),
    y: target.y + CARD.height / 2,
  });
  expect(second?.y).toBe(first?.y);
  expect(Math.sign((second?.x ?? 0) - (first?.x ?? 0))).toBe(isForward ? 1 : -1);
  expect(beforeLast?.y).toBe(last?.y);
  expect(Math.sign((last?.x ?? 0) - (beforeLast?.x ?? 0))).toBe(isForward ? 1 : -1);
};

/** A generator of numbers from 0 to 1 that gives the same numbers for the same seed. */
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
    const layout = computeGraphLayout(buildNodes("start", "open_task", "review"), edges);

    expect(readNode(layout, "start").x + CARD.width).toBeLessThan(readNode(layout, "open_task").x);
    expect(readNode(layout, "open_task").x + CARD.width).toBeLessThan(readNode(layout, "review").x);
    expectHandleToHandle(layout, "e0", "start", "open_task");
    expectHandleToHandle(layout, "e1", "open_task", "review");
    expectClearDrawing(layout, edges);
  });

  it("puts a label between the two ends of its edge, on the edge's route", () => {
    const edges = [{ id: "e0", from: "review", to: "comment", label: LABEL }];
    const layout = computeGraphLayout(buildNodes("review", "comment"), edges);
    const route = readRoute(layout, "e0");
    const labelBox = buildLabelBox(route.label ?? { x: -Infinity, y: -Infinity });

    expect(labelBox.x).toBeGreaterThanOrEqual(readNode(layout, "review").x + CARD.width);
    expect(labelBox.x + labelBox.width).toBeLessThanOrEqual(readNode(layout, "comment").x);
    // The route runs level through the label, so the label sits on it.
    expect(route.points).toContainEqual({ x: labelBox.x, y: route.label?.y });
    expect(route.points).toContainEqual({ x: labelBox.x + labelBox.width, y: route.label?.y });
    expectClearDrawing(layout, edges);
  });

  it("draws an edge from a node to itself as a loop over the node, clear of the node above it", () => {
    // Two nodes in one rank, so a node stands above the node with the loop.
    const edges = [
      { id: "e0", from: "labelled", to: "review" },
      { id: "e1", from: "nightly", to: "review" },
      { id: "loop", from: "nightly", to: "nightly", label: LABEL },
    ];
    const layout = computeGraphLayout(buildNodes("labelled", "nightly", "review"), edges);
    const nightly = readNode(layout, "nightly");
    const loop = readRoute(layout, "loop");

    expectHandleToHandle(layout, "loop", "nightly", "nightly");
    // The loop runs over the top of its node, and its label sits on it.
    expect(Math.min(...loop.points.map((point) => point.y))).toBeLessThan(nightly.y);
    expect(loop.label?.y).toBeLessThan(nightly.y);
    expectClearDrawing(layout, edges);
  });

  it("steps two loops of one node apart, each clear of the other's label", () => {
    const edges = [
      { id: "inner", from: "poll", to: "poll", label: LABEL },
      { id: "outer", from: "poll", to: "poll", label: LABEL },
    ];
    const layout = computeGraphLayout(buildNodes("poll"), edges);
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
    const layout = computeGraphLayout(buildNodes("implement", "open_pr", "review"), edges);

    expect(readNode(layout, "implement").x).toBeLessThan(readNode(layout, "open_pr").x);
    expect(readNode(layout, "open_pr").x).toBeLessThan(readNode(layout, "review").x);
    expectHandleToHandle(layout, "back", "review", "implement", "back");
    expectHandleToHandle(layout, "e0", "implement", "open_pr");
    expectHandleToHandle(layout, "e1", "open_pr", "review");
    expectClearDrawing(layout, edges);
  });

  it("draws the edge that closes a loop backwards whatever order the nodes and edges come in", () => {
    // A signal trigger that leads into the last step of the loop comes first.
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
    );
    const readX = (id: string) => readNode(layout, id).x;

    expect(readX("assigned")).toBeLessThan(readX("implement"));
    expect(readX("implement")).toBeLessThan(readX("open_pr"));
    expect(readX("open_pr")).toBeLessThan(readX("review"));
    expectHandleToHandle(layout, "back", "review", "implement", "back");
    expectClearDrawing(layout, edges);
  });

  it("draws an edge forward when it closes no loop, even when it is marked as one that does", () => {
    const edges = [{ id: "e0", from: "open_task", to: "review", closesLoop: true }];
    const layout = computeGraphLayout(buildNodes("open_task", "review"), edges);

    expect(readNode(layout, "open_task").x).toBeLessThan(readNode(layout, "review").x);
    expectHandleToHandle(layout, "e0", "open_task", "review");
  });

  it("brings two edges back into one node, each clear of the other's label", () => {
    const edges = [
      { id: "e0", from: "plan", to: "build" },
      { id: "e1", from: "build", to: "test" },
      { id: "e2", from: "test", to: "ship" },
      { id: "retry", from: "test", to: "plan", label: LABEL, closesLoop: true },
      { id: "redo", from: "ship", to: "plan", label: { width: 160, height: 20 }, closesLoop: true },
    ];
    const layout = computeGraphLayout(buildNodes("plan", "build", "test", "ship"), edges);

    expectHandleToHandle(layout, "retry", "test", "plan", "back");
    expectHandleToHandle(layout, "redo", "ship", "plan", "back");
    expect(readRoute(layout, "retry").label?.y).not.toBe(readRoute(layout, "redo").label?.y);
    expectClearDrawing(layout, edges);
  });

  it("lays out three edges between the same two nodes, which the engine's order search cannot place", () => {
    const edges = [
      { id: "e0", from: "b", to: "c", label: LABEL },
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "a", to: "c", label: LABEL },
      { id: "e3", from: "a", to: "b" },
      { id: "e4", from: "a", to: "b" },
    ];
    const layout = computeGraphLayout(buildNodes("a", "b", "c"), edges);

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
      const layout = computeGraphLayout(buildNodes(...ids), edges);

      // The line through every node goes from left to right, and the edges
      // that go back to an earlier node are the ones drawn backwards.
      for (const [index, id] of ids.slice(1).entries()) {
        expect(readNode(layout, ids[index]!).x).toBeLessThan(readNode(layout, id).x);
      }
      expectClearDrawing(layout, edges);
    },
  );
});

describe("placeDrawing", () => {
  it("draws a small drawing larger, up to its largest zoom, and a large one at the legible zoom from the pane's edge", () => {
    const pane: Size = { width: 1200, height: 800 };

    // Three cards in a row fit the pane at the largest zoom, centred.
    const small: Size = { width: 520, height: 52 };
    expect(placeDrawing(pane, small)).toEqual({
      x: (1200 - 520 * LARGEST_PLACED_ZOOM) / 2,
      y: (800 - 52 * LARGEST_PLACED_ZOOM) / 2,
      zoom: LARGEST_PLACED_ZOOM,
    });

    // A drawing that fits only a little larger is drawn as large as it fits.
    const wide: Size = { width: 1052, height: 200 };
    expect(placeDrawing(pane, wide).zoom).toBeCloseTo((1200 - 2 * 16) / 1052);

    // A drawing wider than the pane is drawn at the legible zoom and starts
    // at the pane's edge, and it is centred on the axis where it fits.
    const large: Size = { width: 2000, height: 300 };
    expect(placeDrawing(pane, large)).toEqual({ x: 16, y: (800 - 300) / 2, zoom: 1 });
  });
});
