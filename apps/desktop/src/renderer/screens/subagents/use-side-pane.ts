/**
 * The state of a thread's side pane: whether it is open, which surfaces it
 * holds as tabs, which one it shows, and how wide it is.
 *
 * The pane, the tally pill and the header's toggle all read and change the
 * same state from different parts of the React tree, so the state lives in
 * this module and every reader subscribes to it:
 *
 * - Open or closed and the surfaces are kept per thread, in memory, for as
 *   long as the app runs. Each thread starts with the pane closed, and a
 *   thread shows its pane as the user left it, on every one of its pages.
 * - The width is one value for every thread, kept in `localStorage`, because
 *   it depends on the screen rather than on the thread.
 *
 * The layout's changes and the width's limits live in `@hercule/client-core`.
 */
import { useSyncExternalStore } from "react";
import { useMatch } from "@tanstack/react-router";
import {
  CLOSED_SIDE_PANE,
  DEFAULT_SIDE_PANE_WIDTH,
  parseSidePaneWidth,
  type SidePaneLayout,
} from "@hercule/client-core";

const WIDTH_KEY = "hercule.side-pane.width";

const layouts = new Map<string, SidePaneLayout>();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const notifyListeners = (): void => {
  for (const listener of listeners) listener();
};

/** Returns the layout of the side pane of the thread `sessionId`, closed until the user opens it. */
const readLayout = (sessionId: string): SidePaneLayout =>
  layouts.get(sessionId) ?? CLOSED_SIDE_PANE;

/**
 * Returns the width stored in `localStorage`, or the default width when none
 * is stored or the storage cannot be read.
 */
const readWidth = (): number => {
  try {
    return parseSidePaneWidth(localStorage.getItem(WIDTH_KEY));
  } catch {
    return DEFAULT_SIDE_PANE_WIDTH;
  }
};

/**
 * Returns whether the caller is drawn on a thread's screen, the one place
 * with a side pane. It returns false in the Office's thread drawer, which
 * draws the thread page outside that route, so the drawer shows nothing that
 * would open a pane it does not have.
 */
export function useHasSidePane(): boolean {
  return (
    useMatch({ from: "/_connected/_shell/threads/$sessionId", shouldThrow: false }) !== undefined
  );
}

/**
 * Returns the layout of the side pane of the thread `sessionId`, and a
 * function that changes it, such as `changeLayout(togglePane)`. Renders the
 * caller again when the layout changes.
 */
export function useSidePaneLayout(sessionId: string): {
  readonly layout: SidePaneLayout;
  readonly changeLayout: (change: (layout: SidePaneLayout) => SidePaneLayout) => void;
} {
  const layout = useSyncExternalStore(subscribe, () => readLayout(sessionId));
  return {
    layout,
    changeLayout: (change) => {
      layouts.set(sessionId, change(readLayout(sessionId)));
      notifyListeners();
    },
  };
}

/**
 * Returns the width the user last dragged the side pane to, and a function
 * that stores a new one. When the storage refuses the new width, the pane
 * keeps the width it had, which loses nothing that matters.
 */
export function useSidePaneWidth(): readonly [number, (width: number) => void] {
  const width = useSyncExternalStore(subscribe, readWidth);
  return [
    width,
    (next) => {
      try {
        localStorage.setItem(WIDTH_KEY, String(next));
      } catch {
        // The storage is full or denied, so the pane keeps the width it had.
      }
      notifyListeners();
    },
  ];
}

/** Forgets every thread's side pane layout, so each test starts with every pane closed. */
export const forgetSidePaneLayouts = (): void => {
  layouts.clear();
  notifyListeners();
};
