/**
 * The width of the Inbox's pane, kept in `localStorage` because it belongs to
 * the screen, not to the user's account. The frame clamps what it draws to
 * what the window allows, so a stored width is only the user's wish.
 */
import { useSyncExternalStore } from "react";
import {
  INBOX_PANE_DEFAULT_WIDTH,
  INBOX_PANE_MAX_WIDTH,
  INBOX_PANE_MIN_WIDTH,
} from "./inbox-pane-frame";

const WIDTH_KEY = "hercule.inbox.pane-width";

const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Returns the stored width, or the default when none is stored, the storage
 * cannot be read, or the stored text is not a width the pane can have.
 */
const readWidth = (): number => {
  try {
    const width = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(width) && width >= INBOX_PANE_MIN_WIDTH && width <= INBOX_PANE_MAX_WIDTH
      ? width
      : INBOX_PANE_DEFAULT_WIDTH;
  } catch {
    return INBOX_PANE_DEFAULT_WIDTH;
  }
};

/**
 * Returns the width the user last gave the pane, and a function that stores a
 * new one. When the storage refuses it, the pane keeps the width it had.
 */
export function useInboxPaneWidth(): readonly [number, (width: number) => void] {
  const width = useSyncExternalStore(subscribe, readWidth);
  return [
    width,
    (next) => {
      try {
        localStorage.setItem(WIDTH_KEY, String(next));
      } catch {
        // The storage is full or denied, so the pane keeps the width it had.
      }
      for (const listener of listeners) listener();
    },
  ];
}
