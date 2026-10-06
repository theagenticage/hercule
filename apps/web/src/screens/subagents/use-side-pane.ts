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
 * moves to another thread or to a subagent's page. The layout's changes and
 * the width's limits live in `@hercule/client-core`.
 */
import { useSyncExternalStore } from "react";
import { parseSidePaneLayout, parseSidePaneWidth, type SidePaneLayout } from "@hercule/client-core";

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
