/**
 * The sidebar's layout, its width and whether it is collapsed, kept in
 * `localStorage` because it belongs to this device and not to the user's
 * account. The limits and the parsing live in `@hercule/client-core`.
 *
 * The layout is written only when a change ends: the pointer let go, a key
 * pressed, the sidebar shown or hidden. While the user drags the edge, the
 * shell moves it straight in the page, with no write and no render.
 */
import { useSyncExternalStore } from "react";
import {
  DEFAULT_SIDEBAR_LAYOUT,
  parseSidebarLayout,
  type SidebarLayout,
} from "@hercule/client-core";

const LAYOUT_KEY = "hercule.sidebar.layout";

const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

// The text last read from the storage and the layout parsed from it. React
// compares snapshots by identity, so the same text must give the same object.
let lastRaw: string | null = null;
let lastLayout: SidebarLayout = DEFAULT_SIDEBAR_LAYOUT;

/**
 * Returns the layout stored in `localStorage`, or the default layout when
 * none is stored or the storage cannot be read. Returns the same object for
 * as long as the stored text does not change.
 */
export const readSidebarLayout = (): SidebarLayout => {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LAYOUT_KEY);
  } catch {
    return DEFAULT_SIDEBAR_LAYOUT;
  }
  if (raw !== lastRaw) {
    lastRaw = raw;
    lastLayout = parseSidebarLayout(raw);
  }
  return lastLayout;
};

/**
 * Stores `layout` and redraws every component that reads it. When the
 * storage refuses the layout, the sidebar keeps the layout it had, which
 * loses nothing that matters.
 */
export const storeSidebarLayout = (layout: SidebarLayout): void => {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // The storage is full or denied, so the sidebar keeps the layout it had.
  }
  for (const listener of listeners) listener();
};

/** Hides the sidebar when it shows, and shows it when it is hidden, at the width it had. */
export const toggleSidebar = (): void => {
  const layout = readSidebarLayout();
  storeSidebarLayout({ ...layout, collapsed: !layout.collapsed });
};

/** Returns the sidebar's layout, and draws the component again when it changes. */
export function useSidebarLayout(): SidebarLayout {
  return useSyncExternalStore(subscribe, readSidebarLayout);
}
