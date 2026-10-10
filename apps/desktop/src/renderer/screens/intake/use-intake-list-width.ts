/**
 * The width of Intake's list while the pane is open, kept in `localStorage`
 * because it depends on the screen rather than on any signal. The limits
 * live in `@hercule/client-core`.
 */
import { useSyncExternalStore } from "react";
import { DEFAULT_INTAKE_LIST_WIDTH, parseIntakeListWidth } from "@hercule/client-core";

const WIDTH_KEY = "hercule.intake.list-width";

const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Returns the width stored in `localStorage`, or the default width when none
 * is stored or the storage cannot be read.
 */
const readWidth = (): number => {
  try {
    return parseIntakeListWidth(localStorage.getItem(WIDTH_KEY));
  } catch {
    return DEFAULT_INTAKE_LIST_WIDTH;
  }
};

/**
 * Returns the width the user last gave the list, and a function that stores
 * a new one. When the storage refuses the new width, the list keeps the
 * width it had, which loses nothing that matters.
 */
export function useIntakeListWidth(): readonly [number, (width: number) => void] {
  const width = useSyncExternalStore(subscribe, readWidth);
  return [
    width,
    (next) => {
      try {
        localStorage.setItem(WIDTH_KEY, String(next));
      } catch {
        // The storage is full or denied, so the list keeps the width it had.
      }
      for (const listener of listeners) listener();
    },
  ];
}
