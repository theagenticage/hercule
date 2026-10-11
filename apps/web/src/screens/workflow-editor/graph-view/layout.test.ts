import { describe, expect, it } from "vitest";
import type { Size } from "@hercule/client-core/graph-layout";
import {
  computeDrawingViewport,
  computePaneHeight,
  LARGEST_PLACED_ZOOM,
  LEGIBLE_ZOOM,
  MIN_ZOOM,
} from "./layout";

describe("computeDrawingViewport", () => {
  it("scales a small drawing up to the largest zoom, fits a wider one, and shows a large one at the legible zoom from the pane's edge", () => {
    const pane: Size = { width: 1200, height: 800 };

    // Three cards in a row fit the pane at the largest zoom, centred.
    const small: Size = { width: 520, height: 52 };
    expect(computeDrawingViewport(pane, small, LEGIBLE_ZOOM)).toEqual({
      x: (1200 - 520 * LARGEST_PLACED_ZOOM) / 2,
      y: (800 - 52 * LARGEST_PLACED_ZOOM) / 2,
      zoom: LARGEST_PLACED_ZOOM,
    });

    // A drawing that fits only slightly above the legible zoom gets the largest zoom that fits.
    const wide: Size = { width: 1052, height: 200 };
    expect(computeDrawingViewport(pane, wide, LEGIBLE_ZOOM).zoom).toBeCloseTo(
      (1200 - 2 * 16) / 1052,
    );

    // A drawing a little wider than the pane is scaled down until it fits:
    // five step cards of a run in the 258px-high pane of a run's page.
    const run: Size = { width: 1215, height: 52 };
    const runPane: Size = { width: 970, height: 258 };
    const fitted = computeDrawingViewport(runPane, run, LEGIBLE_ZOOM);
    expect(fitted.zoom).toBeCloseTo((970 - 2 * 16) / 1215);
    expect(fitted.x).toBeCloseTo(16);

    // A drawing that fits only at a smaller zoom gets the legible zoom and
    // starts at the pane's left edge. It is still centred vertically, where it fits.
    const large: Size = { width: 2000, height: 300 };
    expect(computeDrawingViewport(pane, large, LEGIBLE_ZOOM)).toEqual({
      x: 16,
      y: (800 - 300 * 0.75) / 2,
      zoom: 0.75,
    });
  });

  it("shows the whole drawing, however small that makes it, when the smallest zoom allows", () => {
    // The demo workflow in the editor's split view: its graph half is about
    // 800px wide, and the drawing needs a zoom below the legible one to fit.
    const pane: Size = { width: 800, height: 900 };
    const demo: Size = { width: 1320, height: 124 };
    const placed = computeDrawingViewport(pane, demo, MIN_ZOOM);
    expect(placed.zoom).toBeCloseTo((800 - 2 * 16) / 1320);
    expect(placed.x).toBeCloseTo(16);
    expect(placed.x + demo.width * placed.zoom).toBeLessThanOrEqual(pane.width);
  });
});

describe("computePaneHeight", () => {
  const SIZING = { heightRange: { min: 120, max: 440 }, smallestPlacedZoom: LEGIBLE_ZOOM };
  /** The room above and below the drawing, clear of the "Fit to view" control. */
  const ROOM = 2 * 40;

  it("fits a pane to the whole drawing at the zoom that fills its width", () => {
    // Two rows of a run's plan, a little narrower than the pane at the legible zoom.
    const plan: Size = { width: 2080, height: 124 };
    const zoom = (1595 - 2 * 16) / 2080;
    expect(computePaneHeight(1595, plan, SIZING)).toBe(Math.ceil(124 * zoom + ROOM));
    // The pane shows the drawing whole: placed in a pane of that height, it fills the width.
    const pane = { width: 1595, height: computePaneHeight(1595, plan, SIZING) };
    expect(computeDrawingViewport(pane, plan, LEGIBLE_ZOOM)).toEqual({
      x: 16,
      y: (pane.height - 124 * zoom) / 2,
      zoom,
    });
  });

  it("gives a small drawing the largest zoom, and one too wide to fit the legible zoom", () => {
    const row: Size = { width: 520, height: 52 };
    expect(computePaneHeight(1200, row, SIZING)).toBe(Math.ceil(52 * LARGEST_PLACED_ZOOM + ROOM));
    const wide: Size = { width: 4000, height: 124 };
    expect(computePaneHeight(1200, wide, SIZING)).toBe(Math.ceil(124 * 0.75 + ROOM));
  });

  it("sizes a pane not yet measured for the largest zoom", () => {
    const plan: Size = { width: 2080, height: 124 };
    expect(computePaneHeight(Number.POSITIVE_INFINITY, plan, SIZING)).toBe(
      Math.ceil(124 * LARGEST_PLACED_ZOOM + ROOM),
    );
  });

  it("keeps the height between the smallest and the largest", () => {
    expect(computePaneHeight(1200, { width: 300, height: 20 }, SIZING)).toBe(120);
    expect(computePaneHeight(1200, { width: 1000, height: 600 }, SIZING)).toBe(440);
  });
});
