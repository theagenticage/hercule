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
 * The order of the stack is the order of the user's gestures, not the order in
 * which the controller answers. A gesture takes its place when the user makes
 * it (`reserve`), while its request is still running, and its inverse waits for
 * that request itself. A request that fails, or that changes nothing, takes
 * its gesture off again and leaves every other gesture where it was.
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

/** What the user is told about an undo: the sentence, and whether it reports a failure. */
export interface UndoReport {
  readonly text: string;
  readonly isFailure: boolean;
}

/**
 * Returns the sentence that tells the user what `outcome` did, or `undefined`
 * for `busy`, which did nothing and needs no words.
 */
export const describeUndoOutcome = (outcome: UndoOutcome): UndoReport | undefined => {
  switch (outcome.kind) {
    case "empty":
      return { text: "Nothing to undo.", isFailure: false };
    case "busy":
      return undefined;
    case "reversed":
      return {
        text: `Put back: ${outcome.words}.${outcome.note === undefined ? "" : ` ${outcome.note}`}`,
        isFailure: false,
      };
    case "failed":
      return {
        text: `Could not put back: ${outcome.words}. ${outcome.reason}`,
        isFailure: true,
      };
  }
};

export interface UndoStack<Page> {
  /**
   * Adds the gesture the user just made as the newest, before its request has
   * answered. Drops the oldest past `MAX_GESTURES`.
   *
   * `willHold` resolves to whether the request changed something that can be
   * reversed. When it resolves to false (the request failed, or changed
   * nothing), the gesture leaves the stack wherever it then is, and the
   * gestures around it keep their order. Does nothing at that point when an
   * undo has already taken the gesture. `willHold` must not reject.
   */
  readonly reserve: (gesture: Gesture<Page>, willHold: Promise<boolean>) => void;
  /**
   * Notes that a page that undoes by itself is open, until the returned
   * function is called. While one is open, that page listens for the Undo key,
   * so nobody else should.
   */
  readonly registerOpenPage: () => () => void;
  /** Returns whether a page that undoes by itself is open (see `registerOpenPage`). */
  readonly hasOpenPage: () => boolean;
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
  let openPages = 0;
  return {
    reserve: (gesture, willHold) => {
      gestures = [...gestures, gesture].slice(-MAX_GESTURES);
      void willHold.then((isHeld) => {
        if (!isHeld) gestures = gestures.filter((each) => each !== gesture);
      });
    },
    registerOpenPage: () => {
      openPages += 1;
      let isRegistered = true;
      return () => {
        if (!isRegistered) return;
        isRegistered = false;
        openPages -= 1;
      };
    },
    hasOpenPage: () => openPages > 0,
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
