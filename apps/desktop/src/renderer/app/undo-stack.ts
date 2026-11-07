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
export interface Gesture<Page> {
  /** What the undo line shows, in the past tense, such as "Moved Review PR to In review". */
  readonly words: string;
  /**
   * Reverses this one gesture. It resolves when the reversal is done, with a
   * note for the undo line to add when the reversal was not exact (or
   * `undefined`), and rejects, with an error that says why, when it cannot be.
   *
   * `page` is what the page that is open when the user presses Undo lends
   * the gesture. A gesture outlives the page that made it: the user may leave
   * the page and come back, and the reversal must then go through the page that
   * is open now.
   *
   * It runs the moment the user asks for it, not once the gesture's own
   * request has finished. A gesture whose request may still be queued must
   * therefore queue its inverse behind that request itself, so a gesture the
   * user makes after Undo is sent after the inverse. The stack just awaits it.
   */
  readonly undo: (page: Page) => Promise<string | undefined>;
}

/** What `undo` did. */
export type UndoOutcome =
  /** There was no gesture to undo. */
  | { readonly kind: "empty" }
  /** Another undo is still running. This call did nothing. */
  | { readonly kind: "busy" }
  /** The gesture with these `words` was reversed. A `note` says what was not exact about it. */
  | { readonly kind: "reversed"; readonly words: string; readonly note?: string }
  /**
   * The gesture with these `words` could not be reversed, for `reason`. The
   * gesture is gone from the stack: what changed since is unknown, so trying
   * it again could undo the wrong thing.
   */
  | { readonly kind: "failed"; readonly words: string; readonly reason: string };

export interface UndoStack<Page> {
  /** Adds the gesture the user just made as the newest. Drops the oldest past `MAX_GESTURES`. */
  readonly push: (gesture: Gesture<Page>) => void;
  /**
   * Takes `gesture` off the stack wherever it is, for a gesture whose request
   * failed and so has nothing to reverse. Does nothing when it is not on the
   * stack, such as when an undo has already taken it.
   */
  readonly remove: (gesture: Gesture<Page>) => void;
  /**
   * Reverses the newest gesture and removes it. Never rejects: a failure is
   * an outcome the screen can say. `page` goes to the gesture (see
   * `Gesture.undo`).
   *
   * Undoes run one at a time. While one runs, another call is ignored and
   * returns `busy`, so a held key does not undo a whole row of gestures.
   */
  readonly undo: (page: Page) => Promise<UndoOutcome>;
  /** Empties the stack. An undo that already runs finishes. */
  readonly clear: () => void;
}

/** Creates an empty undo stack. */
export const createUndoStack = <Page>(): UndoStack<Page> => {
  let gestures: readonly Gesture<Page>[] = [];
  let running = false;
  return {
    push: (gesture) => {
      gestures = [...gestures, gesture].slice(-MAX_GESTURES);
    },
    remove: (gesture) => {
      gestures = gestures.filter((each) => each !== gesture);
    },
    undo: async (page) => {
      if (running) return { kind: "busy" };
      const newest = gestures.at(-1);
      if (newest === undefined) return { kind: "empty" };
      running = true;
      gestures = gestures.slice(0, -1);
      try {
        const note = await newest.undo(page);
        return note === undefined
          ? { kind: "reversed", words: newest.words }
          : { kind: "reversed", words: newest.words, note };
      } catch (error) {
        return { kind: "failed", words: newest.words, reason: readErrorMessage(error) };
      } finally {
        running = false;
      }
    },
    clear: () => {
      gestures = [];
    },
  };
};
