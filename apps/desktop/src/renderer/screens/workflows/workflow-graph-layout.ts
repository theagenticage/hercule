/**
 * The geometry of the workflow graph: the size of each card, of the start
 * triggers' junction and of each edge's label, and the layout built from
 * them with `computeGraphLayout`. The Bureau book draws its graph at the
 * coordinates this layout gives, so a change to any size here moves the
 * graph away from the book.
 *
 * It is imported only by the graph, which loads with the open workflow's
 * route, so the layout engine stays off the first screen.
 */
import { computeGraphLayout, type Size } from "@hercule/client-core/graph-layout";
import type { GraphEdge, WorkflowGraphDrawing } from "@hercule/client-core/graph-model";

/** The size of every card. A longer id or detail is cut short, and the card's tooltip holds it whole. */
export const CARD: Size = { width: 176, height: 48 };

/**
 * The length at each end of a card's side where no edge attaches. It is more
 * than the card's corner radius, so every edge meets a straight side.
 */
const SIDE_MARGIN = 12;

/**
 * The size of the start triggers' junction. It has no width, and room for
 * one attachment point between its margins, so every edge into and out of it
 * meets at its centre, where the graph draws a dot.
 */
export const BUS: Size = { width: 0, height: 2 * SIDE_MARGIN };

/** The line out of a step that ends the run, and the radius of the dot at its end. */
export const END_STUB = 10;
export const END_RADIUS = 4;

/** The room the end dot takes past the layout's right edge. */
const END_ROOM = END_STUB + 2 * END_RADIUS + 2;

/**
 * A label's font size, `--t-11`, and the width of each glyph of the mono
 * face, which is 0.6em for every glyph. So a label's width follows from its
 * length before anything renders.
 */
const LABEL_FONT_SIZE = 11;
const MONO_GLYPH_WIDTH = 0.6;
/** A label's line height and side padding, as `.edge-label` draws it. */
const LABEL_HEIGHT = 15;
const LABEL_PADDING = 4;

/**
 * Returns the room the layout leaves for an edge's label, or `undefined` for
 * an edge with no label. The room fits the widest text the label can show on
 * any run, `3/3` for a limit of 3, so a run drawn on the graph never moves a
 * card.
 */
const measureLabelRoom = (edge: GraphEdge): Size | undefined => {
  const limit =
    edge.maxTraversals === undefined
      ? undefined
      : `${String(edge.maxTraversals)}/${String(edge.maxTraversals)}`;
  const text = [edge.condition, limit].filter((part) => part !== undefined).join(" · ");
  if (text === "") return undefined;
  const width = Math.ceil([...text].length * LABEL_FONT_SIZE * MONO_GLYPH_WIDTH);
  return { width: width + 2 * LABEL_PADDING, height: LABEL_HEIGHT };
};

/** A laid out graph, and the size of its drawing with the end dots. */
export interface GraphDrawingLayout {
  readonly layout: ReturnType<typeof computeGraphLayout>;
  readonly size: Size;
}

/**
 * Lays out `drawing`: where each card goes, and the route of each edge. The
 * layout reads the graph's structure only, so every run of a workflow draws
 * its cards in the same places. An edge with a limit is the one that goes
 * back to the start of its loop.
 */
export const layOutGraphDrawing = (drawing: WorkflowGraphDrawing): GraphDrawingLayout => {
  const layout = computeGraphLayout(
    [
      ...drawing.nodes.map((node) => ({ id: node.id, ...CARD })),
      ...(drawing.busId === undefined ? [] : [{ id: drawing.busId, ...BUS }]),
    ],
    drawing.edges.map((edge) => {
      const label = measureLabelRoom(edge);
      return {
        id: edge.id,
        from: edge.from,
        to: edge.to,
        ...(label === undefined ? {} : { label }),
        closesLoop: edge.maxTraversals !== undefined,
      };
    }),
    SIDE_MARGIN,
  );
  const hasEnd = drawing.nodes.some((node) => node.terminal);
  return {
    layout,
    size: { width: layout.size.width + (hasEnd ? END_ROOM : 0), height: layout.size.height },
  };
};
