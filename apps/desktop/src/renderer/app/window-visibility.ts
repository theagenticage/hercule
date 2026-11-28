/**
 * Whether the window can be seen, for the hooks that hold a live topic, or
 * draw what it delivers, only while someone can see the window (spec 17
 * §Rules, rule 3).
 */
import { useSyncExternalStore } from "react";

/** Calls `onChange` each time the window is hidden or shown. Returns a function that stops. */
const subscribeToVisibility = (onChange: () => void): (() => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => {
    document.removeEventListener("visibilitychange", onChange);
  };
};

/**
 * Checks whether the window can be seen. In Electron the page is hidden
 * while its window is hidden (⌘W hides it) or minimized, and on macOS also
 * while other windows cover it completely.
 */
export const isWindowVisible = (): boolean => document.visibilityState === "visible";

/** Returns whether the window can be seen, and draws the calling component again when that changes. */
export const useWindowVisible = (): boolean =>
  useSyncExternalStore(subscribeToVisibility, isWindowVisible);

/**
 * Waits until the window can be seen, and resolves with `true`. Resolves at
 * once when it can be seen now, and with `false` when `signal` aborts first.
 * A motion that waits for it plays nothing while the window is hidden.
 */
export const waitForVisibleWindow = (signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    if (isWindowVisible()) {
      resolve(true);
      return;
    }
    const finish = (isVisible: boolean): void => {
      document.removeEventListener("visibilitychange", onChange);
      signal.removeEventListener("abort", onAbort);
      resolve(isVisible);
    };
    const onChange = (): void => {
      if (isWindowVisible()) finish(true);
    };
    const onAbort = (): void => {
      finish(false);
    };
    document.addEventListener("visibilitychange", onChange);
    signal.addEventListener("abort", onAbort, { once: true });
  });
