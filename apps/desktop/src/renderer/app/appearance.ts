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
 * The Appearance it shows is built from three parts, applied in order:
 *
 * - the Appearance saved on this Mac;
 * - the changes being saved, in the order they were made;
 * - the changes only shown, such as the Glass level while the slider is
 *   dragged.
 *
 * So a change whose save fails disappears from the screen, and the field
 * shows its saved value again, unless a later change to that field is still
 * being saved.
 *
 * Every change to what it shows tells every subscriber.
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
   * Shows `change` in the window at once without saving it, as the Glass
   * slider does while it is dragged.
   */
  readonly show: (change: Partial<Appearance>) => void;
  /**
   * Shows `change` at once, and saves it on this Mac after every earlier
   * save has finished. The save writes `change` over the saved Appearance,
   * never over what is only shown, so a Glass level being dragged is not
   * saved with another field.
   *
   * Resolves once the change is saved. Fails with an Error whose message is
   * the reason for the user when it is not saved; the change then leaves the
   * screen.
   */
  readonly save: (change: Partial<Appearance>) => Promise<void>;
}

/**
 * Returns the store of the Appearance the page shows, which reads and saves
 * it through `bridge`.
 *
 * The saved Appearance is read the first time it is needed, not here.
 * `theme-init.js` has already read it once before the first paint, and each
 * read is a synchronous message to main. With a saved controller, the
 * router reads it when it starts, because Open on decides the first screen.
 * With none, the app opens on the connect screen, and nothing reads it a
 * second time at launch.
 *
 * Saves run one after another, in the order they were made, so each one
 * writes over what the save before it stored.
 */
export const createAppearanceStore = (bridge: Pick<Bridge, "appearance">): AppearanceStore => {
  let saved: Appearance | null = null;
  const saving: Partial<Appearance>[] = [];
  let shownOnly: Partial<Appearance> = {};
  let shown: Appearance | null = null;
  let lastSave: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();

  const readSaved = (): Appearance => (saved ??= bridge.appearance.read());
  const read = (): Appearance => (shown ??= readSaved());
  const showAgain = (): void => {
    const next = Object.assign({}, readSaved(), ...saving, shownOnly) as Appearance;
    shown = next;
    // `public/theme-init.js` listens for this same event name, and applies
    // the Appearance in its `detail` to the document.
    document.dispatchEvent(new CustomEvent("appearancechange", { detail: next }));
    for (const listener of listeners) listener();
  };
  const write = async (change: Partial<Appearance>): Promise<void> => {
    const next = { ...readSaved(), ...change };
    const outcome = await bridge.appearance.save(next).catch((error: unknown) => {
      // A refusal or a defect is a bug in the app, and its message is not
      // for the user.
      console.error("Could not save the Appearance:", error);
      throw new Error("the app failed to save it");
    });
    if (outcome._tag === "NotSaved") throw new Error(outcome.reason);
    saved = next;
  };

  return {
    read,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    show: (change) => {
      shownOnly = { ...shownOnly, ...change };
      showAgain();
    },
    save: (change) => {
      // The saved change replaces what was only shown of the same fields.
      shownOnly = Object.fromEntries(
        Object.entries(shownOnly).filter(([field]) => !(field in change)),
      );
      saving.push(change);
      showAgain();
      const done = lastSave.then(() => write(change));
      lastSave = done.catch(() => {});
      return done.finally(() => {
        saving.splice(saving.indexOf(change), 1);
        showAgain();
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
