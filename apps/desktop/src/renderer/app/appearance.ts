/**
 * The Appearance the page shows, and the system settings the Appearance page
 * reads (spec 17 §Settings, Appearance).
 *
 * The page never sets the theme or the glass on the document itself.
 * `public/theme-init.js` applies the Appearance before the first paint, and
 * applies it again each time the page dispatches an `appearancechange` event
 * on the document, whose `detail` is the new Appearance. The store below
 * dispatches that event.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { Bridge } from "../../ipc/bridge";
import type { Appearance } from "../../ipc/contract";

/** The media query that matches while macOS is in its dark appearance. */
export const DARK_APPEARANCE_QUERY = "(prefers-color-scheme: dark)";

/** The media query that matches while macOS's Reduce transparency is on. */
export const REDUCED_TRANSPARENCY_QUERY = "(prefers-reduced-transparency: reduce)";

/**
 * The Appearance the page shows. It sits in the router context, as the
 * pending submissions do, so it lasts while the app runs rather than while
 * the Appearance page is open, and main is asked for the saved Appearance
 * once per page load.
 *
 * Every change tells every subscriber.
 */
export interface AppearanceStore {
  /**
   * Returns the Appearance the page shows. The first call reads the saved
   * Appearance from main. The same object comes back until the next change,
   * as React's `useSyncExternalStore` requires.
   */
  readonly read: () => Appearance;
  /** Calls `listener` after every change, until the returned function is called. */
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * Merges `change` into the Appearance the page shows now, and shows the
   * result in the window at once without saving it, as the Glass slider does
   * while it is dragged.
   *
   * The merge starts from what the page shows, not from what was last saved,
   * so a theme picked while the slider is dragged keeps the level it shows.
   */
  readonly show: (change: Partial<Appearance>) => void;
  /**
   * Merges and shows `change` as `show` does, then saves the result on this
   * Mac. If the save fails, the page goes back to the Appearance it showed
   * before, so it never shows one that was not saved.
   */
  readonly save: (change: Partial<Appearance>) => void;
}

/**
 * Returns the store of the Appearance the page shows, which reads and saves
 * it through `bridge`.
 *
 * The saved Appearance is read the first time it is needed, not here:
 * `theme-init.js` has already read it once before the first paint, and a
 * second read at launch would add a second synchronous message to it.
 *
 * A failed save is logged, not thrown, and the page goes back to the
 * Appearance it showed before. A failed save means main refused the message
 * or failed, which is a bug the user cannot act on.
 */
export const createAppearanceStore = (bridge: Pick<Bridge, "appearance">): AppearanceStore => {
  let shown: Appearance | null = null;
  const listeners = new Set<() => void>();
  const read = (): Appearance => (shown ??= bridge.appearance.read());
  const show = (change: Partial<Appearance>): void => {
    const next = { ...read(), ...change };
    shown = next;
    // `public/theme-init.js` listens for this same event name, and applies
    // the Appearance in its `detail` to the document.
    document.dispatchEvent(new CustomEvent("appearancechange", { detail: next }));
    for (const listener of listeners) listener();
  };
  return {
    read,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    show,
    save: (change) => {
      const previous = read();
      show(change);
      const next = read();
      bridge.appearance.save(next).catch((error: unknown) => {
        console.error("Could not save the Appearance:", error);
        // If the page already shows a later change, that change stays: its
        // own save keeps it or takes it back.
        if (shown === next) show(previous);
      });
    },
  };
};

/** Returns the Appearance `store` holds, and renders again each time it changes. */
export function useAppearance(store: AppearanceStore): Appearance {
  return useSyncExternalStore(store.subscribe, store.read);
}

/**
 * Returns whether the media query `query` matches, such as
 * `DARK_APPEARANCE_QUERY`, and renders again each time the answer changes.
 */
export function useMediaQueryMatch(query: string): boolean {
  const list = useMemo(() => window.matchMedia(query), [query]);
  const subscribe = useCallback(
    (listener: () => void) => {
      list.addEventListener("change", listener);
      return () => {
        list.removeEventListener("change", listener);
      };
    },
    [list],
  );
  return useSyncExternalStore(subscribe, () => list.matches);
}
