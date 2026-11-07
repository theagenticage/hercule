/**
 * The undo stack: the gestures the user made in this window, newest last, for
 * both pages of the Overview (Work and Inbox) and the undo line they share.
 *
 * A gesture is one thing the user did, such as moving a card or marking a
 * Task done. It holds the inverse of that one gesture, never a copy of the
 * board. A copy would also undo what arrived since: another person's move, a
 * run that failed. So Undo puts back what the user did, one gesture at a time,
 * and nothing else.
 *
 * The stack belongs to one controller and one user. The owner creates a new
 * stack, or calls `clear`, when either changes and when the user signs out.
 * Nothing is saved: closing the window drops it.
 */
import { readErrorMessage } from "@hercule/client-core";

/** The most gestures the stack keeps. The oldest is dropped past this. */
export const MAX_GESTURES = 50;

/** One thing the user did, and how to reverse it. */
export interface Gesture {
  /** What the undo line shows, in the past tense, such as "Moved Review PR to In review". */
  readonly words: string;
  /**
   * Reverses this one gesture. It resolves when the reversal is done and
   * rejects, with an error that says why, when it cannot be.
   *
   * It runs only once the gesture's own request has finished, so the function
   * itself waits for that request before it sends the inverse. The stack just
   * awaits it.
   */
  readonly undo: () => Promise<void>;
}

/** What `undo` did. */
export type UndoOutcome =
  /** There was no gesture to undo. */
  | { readonly kind: "empty" }
  /** Another undo is still running. This call did nothing. */
  | { readonly kind: "busy" }
  /** The gesture with these `words` was reversed. */
  | { readonly kind: "reversed"; readonly words: string }
  /**
   * The gesture with these `words` could not be reversed, for `reason`. The
   * gesture is gone from the stack: what changed since is unknown, so trying
   * it again could undo the wrong thing.
   */
  | { readonly kind: "failed"; readonly words: string; readonly reason: string };

export interface UndoStack {
  /** Adds the gesture the user just made as the newest. Drops the oldest past `MAX_GESTURES`. */
  readonly push: (gesture: Gesture) => void;
  /**
   * Reverses the newest gesture and removes it. Never rejects: a failure is
   * an outcome the screen can say.
   *
   * Undoes run one at a time. While one runs, another call is ignored and
   * returns `busy`, so a held key does not undo a whole row of gestures.
   */
  readonly undo: () => Promise<UndoOutcome>;
  /** Returns the newest gesture, or `null` for none. The same object comes back until the stack changes. */
  readonly peek: () => Gesture | null;
  /** Empties the stack. An undo that already runs finishes. */
  readonly clear: () => void;
  /** Calls `listener` after every change of the stack; returns the function that stops that. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** Creates an empty undo stack. */
export const createUndoStack = (): UndoStack => {
  let gestures: readonly Gesture[] = [];
  let running = false;
  const listeners = new Set<() => void>();
  const change = (next: readonly Gesture[]): void => {
    gestures = next;
    for (const listener of listeners) listener();
  };
  return {
    push: (gesture) => {
      change([...gestures, gesture].slice(-MAX_GESTURES));
    },
    undo: async () => {
      if (running) return { kind: "busy" };
      const newest = gestures.at(-1);
      if (newest === undefined) return { kind: "empty" };
      running = true;
      change(gestures.slice(0, -1));
      try {
        await newest.undo();
        return { kind: "reversed", words: newest.words };
      } catch (error) {
        return { kind: "failed", words: newest.words, reason: readErrorMessage(error) };
      } finally {
        running = false;
      }
    },
    peek: () => gestures.at(-1) ?? null,
    clear: () => {
      if (gestures.length > 0) change([]);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
