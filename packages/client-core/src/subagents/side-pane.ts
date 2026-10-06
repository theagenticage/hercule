/**
 * The state of a thread's side pane, apart from where an app keeps it:
 * whether the pane is open, which surfaces it holds as tabs, which one it
 * shows, and how wide it is. Each change is a function from one layout to the
 * next, so the web app and the desktop app change the pane by the same rules
 * and differ only in where they store the result.
 */

/** A kind of surface the side pane can show. Subagents is the only one in v1. */
export type SidePaneSurface = "subagents";

/** The surfaces the "+" picker offers, in its order, with their names and keys. */
export const SIDE_PANE_SURFACES: readonly {
  readonly kind: SidePaneSurface;
  readonly name: string;
  /** The key that opens the surface while the picker is open. */
  readonly key: string;
}[] = [{ kind: "subagents", name: "Subagents", key: "S" }];

/** Whether the side pane is open, the surfaces it holds as tabs, and the one it shows. */
export interface SidePaneLayout {
  readonly open: boolean;
  /** The surfaces in tab order. Empty only while the pane is closed. */
  readonly surfaces: readonly SidePaneSurface[];
  /** The surface the pane shows; one of `surfaces`, or undefined when there are none. */
  readonly shown: SidePaneSurface | undefined;
}

/** The layout of a side pane that has not been opened yet. */
export const CLOSED_SIDE_PANE: SidePaneLayout = { open: false, surfaces: [], shown: undefined };

/** The width of the pane, in pixels, until the user drags it. */
export const DEFAULT_SIDE_PANE_WIDTH = 420;

/** The narrowest the user can drag the pane. */
export const MIN_SIDE_PANE_WIDTH = 300;

/** The narrowest the pane may leave the main pane beside it. */
export const MIN_MAIN_PANE_WIDTH = 520;

/** Returns `layout` with the pane open on `surface`, adding its tab when it has none. */
export const openSurface = (layout: SidePaneLayout, surface: SidePaneSurface): SidePaneLayout => ({
  open: true,
  surfaces: layout.surfaces.includes(surface) ? layout.surfaces : [...layout.surfaces, surface],
  shown: surface,
});

/**
 * Returns `layout` without the tab of `surface`. Closing the last tab closes
 * the pane. Closing the shown tab shows the last of the tabs that remain.
 */
export const closeSurface = (layout: SidePaneLayout, surface: SidePaneSurface): SidePaneLayout => {
  const surfaces = layout.surfaces.filter((each) => each !== surface);
  if (surfaces.length === 0) return CLOSED_SIDE_PANE;
  return { ...layout, surfaces, shown: layout.shown === surface ? surfaces.at(-1) : layout.shown };
};

/**
 * Returns `layout` with the pane closed if it was open, or open if it was
 * closed. A pane that holds no tabs opens on the Subagents surface, so it
 * never opens empty.
 */
export const togglePane = (layout: SidePaneLayout): SidePaneLayout => {
  if (layout.open) return { ...layout, open: false };
  if (layout.surfaces.length === 0) return openSurface(layout, "subagents");
  return { ...layout, open: true };
};

/**
 * Returns `layout` with the pane closed if it already shows `surface`, and
 * otherwise open on `surface`. The tally pill toggles the Subagents surface
 * this way.
 */
export const toggleSurface = (layout: SidePaneLayout, surface: SidePaneSurface): SidePaneLayout =>
  layout.open && layout.shown === surface
    ? { ...layout, open: false }
    : openSurface(layout, surface);

/** Checks whether `value` names a surface the pane knows. */
const isSidePaneSurface = (value: unknown): value is SidePaneSurface =>
  SIDE_PANE_SURFACES.some((each) => each.kind === value);

/**
 * Parses the stored layout. Returns `CLOSED_SIDE_PANE` for nothing stored and
 * for anything that is not a layout, such as a surface an older version
 * offered, so a bad value closes the pane instead of breaking the thread.
 */
export const parseSidePaneLayout = (raw: string | null): SidePaneLayout => {
  if (raw === null) return CLOSED_SIDE_PANE;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return CLOSED_SIDE_PANE;
  }
  if (typeof value !== "object" || value === null) return CLOSED_SIDE_PANE;
  const { open, surfaces, shown } = value as Record<string, unknown>;
  if (typeof open !== "boolean" || !Array.isArray(surfaces)) return CLOSED_SIDE_PANE;
  const known = surfaces.filter(isSidePaneSurface);
  if (known.length === 0) return CLOSED_SIDE_PANE;
  return {
    open,
    surfaces: known,
    shown: isSidePaneSurface(shown) && known.includes(shown) ? shown : known.at(-1),
  };
};

/**
 * Parses the stored width. Returns `DEFAULT_SIDE_PANE_WIDTH` for nothing
 * stored and for anything that is not a width the user could have dragged to.
 */
export const parseSidePaneWidth = (raw: string | null): number => {
  const width = Number(raw);
  return raw === null || !Number.isFinite(width) || width < MIN_SIDE_PANE_WIDTH
    ? DEFAULT_SIDE_PANE_WIDTH
    : Math.round(width);
};

/**
 * Returns the pane's width to draw: `width`, made no narrower than
 * `MIN_SIDE_PANE_WIDTH` and narrow enough to leave the main pane
 * `MIN_MAIN_PANE_WIDTH`. `available` is the width the main pane and the side
 * pane share; undefined, before it is measured, leaves `width` as it is.
 * When the window is too narrow for both minimums, the pane keeps its own.
 */
export const fitSidePaneWidth = (width: number, available: number | undefined): number => {
  const widest = available === undefined ? width : available - MIN_MAIN_PANE_WIDTH;
  return Math.max(MIN_SIDE_PANE_WIDTH, Math.min(width, widest));
};
