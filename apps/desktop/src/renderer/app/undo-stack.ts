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
 * Undo is shown by whoever is on screen. A desk page (Work or the Inbox)
 * registers an `UndoAdapter` while it is mounted: it draws the change through
 * its own pending changes and says what happened on its own undo line. The
 * shell registers a fallback for every other screen, which writes the cached
 * Work board and Inbox and says what happened in a toast. `undo` picks the
 * page's adapter when there is one, so a key press and the undo line's button
 * both go through one call and never undo twice.
 *
 * The stack belongs to one controller and one user. The owner creates a new
 * stack, or calls `clear`, when either changes and when the user signs out.
 * Nothing is saved: closing the window drops it.
 */
import { readErrorMessage } from "@hercule/client-core";

/** The most gestures the stack keeps. The oldest is dropped past this. */
export const MAX_GESTURES = 50;

/** A button the undo line offers beside Undo, such as "See its Task". */
export interface UndoAction {
  readonly label: string;
  readonly act: () => void;
}

/**
 * What an undo says in its own words, for an undo whose answer is not simply
 * "put back": the controller may have stopped a run instead of reversing it.
 * `text` replaces the default sentence, so it carries no "Put back:" prefix.
 */
export interface UndoAnswer {
  readonly text: string;
  readonly action?: UndoAction;
}

/** One thing the user did, and how to reverse it. */
export interface Gesture<Page> {
  /** What the undo line shows, in the past tense, such as "Moved Review PR to In review". */
  readonly words: string;
  /**
   * Reverses this one gesture. It resolves when the reversal is done, with a
   * note for the undo line to add when the reversal was not exact (or
   * `undefined`), and rejects, with an error that says why, when it cannot be.
   * It resolves to an `UndoAnswer` instead when the undo has its own words,
   * which the line shows in place of "Put back: ...". Either way the gesture
   * is gone from the stack afterwards.
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
  readonly undo: (page: Page) => Promise<string | UndoAnswer | undefined>;
}

/**
 * What a screen offers the stack so that Undo works through it: what it lends
 * to a gesture, and where it tells the user what happened.
 */
export interface UndoAdapter<Page> {
  /**
   * Returns what this screen lends to a gesture when it is undone (see
   * `Gesture.undo`). It runs when Undo is pressed, so it may use the newest
   * state of the screen.
   */
  readonly buildPage: () => Page;
  /** Tells the user what an undo did, except an undo that did nothing. */
  readonly report: (report: UndoReport) => void;
  /**
   * Returns whether Undo must wait because the screen cannot take a change
   * now, such as Work while a card is in the hand of a drag. Optional: a
   * screen that can always take one leaves it out.
   */
  readonly isPaused?: () => boolean;
}

/** What `undo` did. */
export type UndoOutcome =
  /** There was no gesture to undo. */
  | { readonly kind: "empty" }
  /** Another undo is still running, or the screen is paused (see `UndoAdapter.isPaused`). This call did nothing. */
  | { readonly kind: "busy" }
  /** The gesture with these `words` was reversed. A `note` says what was not exact about it. */
  | { readonly kind: "reversed"; readonly words: string; readonly note?: string }
  /** The gesture's undo has its own words (see `UndoAnswer`). It is never a failure. */
  | ({ readonly kind: "answered" } & UndoAnswer)
  /**
   * The gesture with these `words` could not be reversed, for `reason`. The
   * gesture is gone from the stack: what changed since is unknown, so trying
   * it again could undo the wrong thing.
   */
  | { readonly kind: "failed"; readonly words: string; readonly reason: string };

/** What the user is told about an undo: the sentence, whether it reports a failure, and a button that goes with it. */
export interface UndoReport {
  readonly text: string;
  readonly isFailure: boolean;
  readonly action?: UndoAction;
}

/**
 * Returns the sentence that tells the user what `outcome` did, or `undefined`
 * for `busy`, which did nothing and needs no words.
 */
const describeUndoOutcome = (outcome: UndoOutcome): UndoReport | undefined => {
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
    case "answered":
      return outcome.action === undefined
        ? { text: outcome.text, isFailure: false }
        : { text: outcome.text, isFailure: false, action: outcome.action };
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
   * Makes `page` the screen that shows Undo, until the returned function is
   * called. The newest page wins. Leaving a page that a newer page has
   * replaced changes nothing.
   */
  readonly registerPage: (page: UndoAdapter<Page>) => () => void;
  /**
   * Sets the screen that shows Undo when no page is registered, until the
   * returned function is called.
   */
  readonly registerFallback: (fallback: UndoAdapter<Page>) => () => void;
  /**
   * Reverses the newest gesture and removes it, through the registered page
   * or else the fallback, which also tell the user what happened. Never
   * rejects: a failure is an outcome that is said.
   *
   * Undoes run one at a time. While one runs, another call is ignored and
   * returns `busy`, so a held key does not undo a whole row of gestures.
   */
  readonly undo: () => Promise<UndoOutcome>;
  /**
   * Takes `gesture` off the stack, for a gesture that cannot be undone any
   * more, such as an intent that has been sent. Does nothing when it is not on
   * the stack, such as when an undo has already taken it.
   */
  readonly remove: (gesture: Gesture<Page>) => void;
  /** Whether `gesture` is on the stack now. False once it was undone, removed, cleared or given up by `reserve`. */
  readonly holds: (gesture: Gesture<Page>) => boolean;
  /** Empties the stack. An undo that already runs finishes. */
  readonly clear: () => void;
}

/** Creates an empty undo stack. */
export const createUndoStack = <Page>(): UndoStack<Page> => {
  let gestures: readonly Gesture<Page>[] = [];
  let running = false;
  let page: UndoAdapter<Page> | undefined;
  let fallback: UndoAdapter<Page> | undefined;

  const reverseNewest = async (lent: Page): Promise<UndoOutcome> => {
    if (running) return { kind: "busy" };
    const newest = gestures.at(-1);
    if (newest === undefined) return { kind: "empty" };
    running = true;
    gestures = gestures.slice(0, -1);
    try {
      const result = await newest.undo(lent);
      if (typeof result === "object") return { kind: "answered", ...result };
      return result === undefined
        ? { kind: "reversed", words: newest.words }
        : { kind: "reversed", words: newest.words, note: result };
    } catch (error) {
      return { kind: "failed", words: newest.words, reason: readErrorMessage(error) };
    } finally {
      running = false;
    }
  };

  return {
    reserve: (gesture, willHold) => {
      gestures = [...gestures, gesture].slice(-MAX_GESTURES);
      void willHold.then((isHeld) => {
        if (!isHeld) gestures = gestures.filter((each) => each !== gesture);
      });
    },
    registerPage: (adapter) => {
      page = adapter;
      return () => {
        if (page === adapter) page = undefined;
      };
    },
    registerFallback: (adapter) => {
      fallback = adapter;
      return () => {
        if (fallback === adapter) fallback = undefined;
      };
    },
    undo: async () => {
      const adapter = page ?? fallback;
      if (adapter === undefined || adapter.isPaused?.() === true) return { kind: "busy" };
      const outcome = await reverseNewest(adapter.buildPage());
      const report = describeUndoOutcome(outcome);
      if (report !== undefined) adapter.report(report);
      return outcome;
    },
    remove: (gesture) => {
      gestures = gestures.filter((each) => each !== gesture);
    },
    holds: (gesture) => gestures.includes(gesture),
    clear: () => {
      gestures = [];
    },
  };
};
