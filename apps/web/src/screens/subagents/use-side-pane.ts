/**
 * The state of the thread's side pane: whether it is open, which surfaces it
 * holds as tabs, which one it shows, and how wide it is.
 *
 * The pane, the tally pill and the header's toggle all read and change the
 * same state, but they sit in different parts of the React tree, so the state
 * lives in browser storage and every reader subscribes to it:
 *
 * - Open or closed and the surfaces are kept per browser tab, in
 *   `sessionStorage`, so two tabs can show different things.
 * - The width is kept per browser, in `localStorage`, because it depends on
 *   the screen rather than on what the user is doing.
 *
 * Both are one value for every thread: the pane stays as it was when the user
 * moves to another thread or to a subagent's page.
 */
import { useSyncExternalStore } from "react";

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

/** The layout of a browser tab that has never opened the pane. */
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

/**
 * A value kept in browser storage under one key, which every component that
 * reads it through `useStoredValue` sees change at once.
 */
interface StoredValue<T> {
  readonly read: () => T;
  readonly write: (value: T) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * Creates a `StoredValue` kept in `storage` under `key`. The stored text is
 * the single source of truth: `read` parses it again only when it changed, so
 * React sees the same value until a write. When the browser denies storage,
 * or refuses a write, the value lives in memory until the page reloads.
 */
const createStoredValue = <T>(
  storage: () => Storage,
  key: string,
  parse: (raw: string | null) => T,
  serialize: (value: T) => string,
): StoredValue<T> => {
  const listeners = new Set<() => void>();
  let memory: string | null = null;
  // Once a write is refused, such as when storage is full, the value in
  // memory is the newer one, so reads keep coming from memory.
  let inMemory = false;
  let last: { readonly raw: string | null; readonly value: T } | undefined;
  const readRaw = (): string | null => {
    if (inMemory) return memory;
    try {
      return storage().getItem(key);
    } catch {
      return memory;
    }
  };
  return {
    read: () => {
      const raw = readRaw();
      if (last === undefined || last.raw !== raw) last = { raw, value: parse(raw) };
      return last.value;
    },
    write: (value) => {
      const raw = serialize(value);
      try {
        storage().setItem(key, raw);
      } catch {
        // The value stays in memory instead; losing it on a reload is harmless.
        memory = raw;
        inMemory = true;
      }
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

const storedLayout = createStoredValue(
  () => sessionStorage,
  "hercule.side-pane",
  parseSidePaneLayout,
  (layout) => JSON.stringify(layout),
);

const storedWidth = createStoredValue(
  () => localStorage,
  "hercule.side-pane.width",
  parseSidePaneWidth,
  String,
);

/** Returns the current value of `stored`, and renders the caller again when it changes. */
const useStoredValue = <T>(stored: StoredValue<T>): T =>
  useSyncExternalStore(stored.subscribe, stored.read);

/**
 * Returns the side pane's layout in this browser tab, and a function that
 * changes it, such as `changeLayout(togglePane)`.
 */
export function useSidePaneLayout(): {
  readonly layout: SidePaneLayout;
  readonly changeLayout: (change: (layout: SidePaneLayout) => SidePaneLayout) => void;
} {
  const layout = useStoredValue(storedLayout);
  return {
    layout,
    changeLayout: (change) => {
      storedLayout.write(change(storedLayout.read()));
    },
  };
}

/**
 * Returns the width the user last dragged the side pane to in this browser,
 * and a function that stores a new one.
 */
export function useSidePaneWidth(): readonly [number, (width: number) => void] {
  return [useStoredValue(storedWidth), storedWidth.write];
}
