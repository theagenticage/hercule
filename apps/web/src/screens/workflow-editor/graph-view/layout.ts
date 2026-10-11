/**
 * Places a laid-out drawing in its pane: the zoom it opens at, where it sits,
 * and how tall a pane sized to it is. The positions of the cards and edges
 * inside the drawing come from `computeGraphLayout` in
 * `@hercule/client-core/graph-layout`.
 */
import type { Point, Size } from "@hercule/client-core/graph-layout";

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
 * How a pane sizes itself to its drawing, rather than filling its parent.
 */
export interface PaneSizing {
  /**
   * The heights the pane may take. Within them, the pane is as tall as the
   * whole drawing needs (see `computePaneHeight`).
   */
  readonly heightRange: { readonly min: number; readonly max: number };
  /**
   * The smallest zoom the drawing is placed at when it opens, and the zoom
   * the pane's height is computed for when the drawing is too wide to fit.
   */
  readonly smallestPlacedZoom: number;
}

/**
 * Computes the height of a pane `paneWidth` wide that shows a whole drawing,
 * within `sizing.heightRange`.
 *
 * The drawing is placed at the zoom at which it fills the pane's width, as
 * `computeDrawingViewport` places it, and the pane is as tall as the drawing
 * at that zoom plus `FIT_CONTROL_ROOM` above and below. A pane that is not
 * yet measured has an infinite width, which gives the drawing its largest
 * zoom. A drawing too wide to fit at `sizing.smallestPlacedZoom` is sized at
 * that zoom, and the reader pans to see the rest.
 */
export const computePaneHeight = (paneWidth: number, drawing: Size, sizing: PaneSizing): number => {
  const { min, max } = sizing.heightRange;
  const zoom = computePlacedZoom(
    (paneWidth - 2 * PANE_MARGIN) / drawing.width,
    sizing.smallestPlacedZoom,
  );
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
