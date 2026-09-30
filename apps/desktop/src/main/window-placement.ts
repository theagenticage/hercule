/**
 * Where the window opens: its size at first launch, its minimum size, and
 * where a saved position goes when the displays have changed since it was
 * saved. Every size and position is in points, as Electron measures them.
 */
import type { Bounds } from "./app-settings";

/**
 * The window's size at first launch: the size the Bureau pages are drawn at
 * (spec 17, §Design system).
 */
export const DEFAULT_WINDOW_SIZE = { width: 1440, height: 900 } as const;

/**
 * The smallest the window can be made. The frame keeps its 272-point sidebar
 * at every width, so the main pane is what shrinks. Measured on the Bureau
 * pages in Chromium: an empty thread's composer stops fitting the main pane
 * below a window width of 776, and its start cards stop fitting below a
 * height of 440. The minimum rounds both up, to leave a little room.
 */
export const MINIMUM_WINDOW_SIZE = { width: 800, height: 500 } as const;

/** A display, as far as placing a window goes: the part of it windows may cover. */
export interface Display {
  /** The display's bounds minus the menu bar and the Dock. */
  readonly workArea: Bounds;
}

/**
 * Returns `bounds` moved and, if they are too big, shrunk so that they lie
 * wholly inside `area`, but never smaller than `MINIMUM_WINDOW_SIZE`. Bounds
 * already inside come back unchanged. In an area smaller than the minimum
 * size, the window sits at the area's top-left corner and hangs off the rest.
 */
const fitInside = (bounds: Bounds, area: Bounds): Bounds => {
  const width = Math.max(Math.min(bounds.width, area.width), MINIMUM_WINDOW_SIZE.width);
  const height = Math.max(Math.min(bounds.height, area.height), MINIMUM_WINDOW_SIZE.height);
  return {
    x: Math.max(Math.min(bounds.x, area.x + area.width - width), area.x),
    y: Math.max(Math.min(bounds.y, area.y + area.height - height), area.y),
    width,
    height,
  };
};

/** Returns the area two rectangles share; 0 when they do not overlap or only touch. */
const measureOverlap = (a: Bounds, b: Bounds): number =>
  Math.max(Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x), 0) *
  Math.max(Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y), 0);

/** Returns the distance between the closest points of two rectangles; 0 when they overlap or touch. */
const measureDistance = (a: Bounds, b: Bounds): number =>
  Math.hypot(
    Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width), 0),
    Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height), 0),
  );

/**
 * Returns the window's bounds at first launch: `DEFAULT_WINDOW_SIZE`,
 * centred in the display's work area, and shrunk to the work area when the
 * display is smaller than that.
 */
export const buildDefaultWindowBounds = (workArea: Bounds): Bounds => {
  const width = Math.min(DEFAULT_WINDOW_SIZE.width, workArea.width);
  const height = Math.min(DEFAULT_WINDOW_SIZE.height, workArea.height);
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
};

/**
 * Returns the display for which `measure` returns the smallest number, or
 * undefined when there is no display.
 */
const findDisplayWithLeast = (
  displays: ReadonlyArray<Display>,
  measure: (display: Display) => number,
): Display | undefined =>
  displays.reduce<Display | undefined>(
    (best, display) => (best === undefined || measure(display) < measure(best) ? display : best),
    undefined,
  );

/**
 * Returns where to open a window saved at `saved`, given the displays
 * connected now.
 *
 * - When the saved bounds overlap some display's work area, the window opens
 *   exactly where it was, even if part of it hangs off the edge: the user
 *   may have put it there, and a visible part can be dragged back. The one
 *   exception is a window bigger than the work area it overlaps most, as when
 *   it was saved on a larger display: it is shrunk into that work area.
 * - When they overlap none, for example because the display they were on
 *   is gone, the window moves onto the nearest display: into its work area,
 *   at the point closest to where it was, and shrunk if it does not fit.
 *
 * A window is never shrunk below `MINIMUM_WINDOW_SIZE`. With no display at
 * all, which Electron never reports, the saved bounds come back unchanged.
 */
export const placeWindowOnDisplays = (saved: Bounds, displays: ReadonlyArray<Display>): Bounds => {
  // The display the window overlaps most is the one that leaves least of it uncovered.
  const mostOverlapped = findDisplayWithLeast(
    displays,
    (display) => saved.width * saved.height - measureOverlap(saved, display.workArea),
  );
  if (mostOverlapped !== undefined && measureOverlap(saved, mostOverlapped.workArea) > 0) {
    const area = mostOverlapped.workArea;
    return saved.width > area.width || saved.height > area.height ? fitInside(saved, area) : saved;
  }
  const nearest = findDisplayWithLeast(displays, (display) =>
    measureDistance(saved, display.workArea),
  );
  return nearest === undefined ? saved : fitInside(saved, nearest.workArea);
};
