/**
 * The desktop sidebar's layout: how wide it is and whether it is collapsed.
 * The app keeps the layout per device, so these functions only parse it,
 * keep its width within limits and decide what a drag of its edge ends in.
 */

import { MIN_MAIN_PANE_WIDTH } from "./threads/side-pane";

/** The sidebar's width until the user drags its edge, in pixels: the Bureau book's. */
export const DEFAULT_SIDEBAR_WIDTH = 272;

/** The narrowest the sidebar may be, in pixels. */
export const MIN_SIDEBAR_WIDTH = 232;

/** The widest the sidebar may be, in pixels, however wide the window is. */
export const MAX_SIDEBAR_WIDTH = 420;

/**
 * The width below which a drag of the sidebar's edge collapses the sidebar
 * when the pointer is let go, in pixels. Between it and the minimum, the
 * sidebar stays at its minimum.
 */
const SIDEBAR_COLLAPSE_WIDTH = 160;

/** How the sidebar is laid out on this device. */
export interface SidebarLayout {
  /** The width the sidebar has while it shows, in pixels. A collapsed sidebar keeps it for when it opens again. */
  readonly width: number;
  /** Whether the sidebar is collapsed, so the main pane has the whole window. */
  readonly collapsed: boolean;
}

/** The layout before the user changes it: the sidebar showing at its default width. */
export const DEFAULT_SIDEBAR_LAYOUT: SidebarLayout = {
  width: DEFAULT_SIDEBAR_WIDTH,
  collapsed: false,
};

/**
 * Returns the sidebar's width to draw in a window `windowWidth` wide:
 * `width`, kept between the minimum and the maximum, and narrow enough to
 * leave the main pane `MIN_MAIN_PANE_WIDTH`. The minimum wins over the main
 * pane's room, because the window is never narrower than the two together.
 */
export const fitSidebarWidth = (width: number, windowWidth: number): number =>
  Math.round(
    Math.max(
      MIN_SIDEBAR_WIDTH,
      Math.min(width, MAX_SIDEBAR_WIDTH, windowWidth - MIN_MAIN_PANE_WIDTH),
    ),
  );

/**
 * Parses the stored layout, a JSON object such as
 * `{"width":300,"collapsed":false}`. Returns `DEFAULT_SIDEBAR_LAYOUT` for
 * nothing stored and for anything that is not such an object. A width
 * outside the limits falls back to the default width, and a `collapsed`
 * that is not a boolean to `false`, each on its own.
 */
export const parseSidebarLayout = (raw: string | null): SidebarLayout => {
  if (raw === null) return DEFAULT_SIDEBAR_LAYOUT;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return DEFAULT_SIDEBAR_LAYOUT;
  }
  if (typeof stored !== "object" || stored === null) return DEFAULT_SIDEBAR_LAYOUT;
  const { width, collapsed } = stored as { width?: unknown; collapsed?: unknown };
  return {
    width:
      typeof width === "number" && width >= MIN_SIDEBAR_WIDTH && width <= MAX_SIDEBAR_WIDTH
        ? Math.round(width)
        : DEFAULT_SIDEBAR_WIDTH,
    collapsed: collapsed === true,
  };
};

/**
 * Returns the layout a drag of the sidebar's edge ends in, when the pointer
 * is let go with the edge at `draggedWidth`, in a window `windowWidth` wide.
 * `widthBefore` is the sidebar's width when the drag started.
 *
 * - Below `SIDEBAR_COLLAPSE_WIDTH`, the sidebar collapses and keeps
 *   `widthBefore`, so it opens again at the width it had.
 * - Otherwise the sidebar shows at `draggedWidth`, fitted to the window by
 *   `fitSidebarWidth`.
 */
export const decideSidebarDragEnd = (
  draggedWidth: number,
  widthBefore: number,
  windowWidth: number,
): SidebarLayout =>
  draggedWidth < SIDEBAR_COLLAPSE_WIDTH
    ? { width: widthBefore, collapsed: true }
    : { width: fitSidebarWidth(draggedWidth, windowWidth), collapsed: false };
