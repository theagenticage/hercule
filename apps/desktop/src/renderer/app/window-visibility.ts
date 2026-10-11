/**
 * Whether the window can be seen, for the hooks that hold a live topic only
 * while someone can see what it changes (spec 17 §Rules, rule 3).
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
const isWindowVisible = (): boolean => document.visibilityState === "visible";

/** Returns whether the window can be seen, and draws the calling component again when that changes. */
export const useWindowVisible = (): boolean =>
  useSyncExternalStore(subscribeToVisibility, isWindowVisible);
