/**
 * The pending submissions: for each thread, what the user has typed and
 * picked in its composer and not sent yet.
 *
 * The store is held in memory for as long as the app runs, so a thread keeps
 * its unsent text and picks while the user looks at another thread, and
 * loses them at quit (spec 17 §The thread). It sits in the router context,
 * rather than in the composer, because the composer unmounts when the user
 * leaves the thread.
 */
import type { MessageDraft, ThreadPicks } from "@hercule/client-core";

/** What one thread's composer holds and has not sent. */
export interface PendingSubmission {
  /** The text in the composer's field. */
  readonly message: MessageDraft;
  /** The model and options the user picked since the last submission. */
  readonly picks: ThreadPicks;
}

/** The pending submission of every thread, keyed by the thread's session id. */
export interface PendingSubmissions {
  /**
   * Returns the pending submission of `sessionId`, or an empty one when the
   * thread has none. The same object comes back until the next `write` for
   * the thread, as React's `useSyncExternalStore` requires.
   */
  readonly read: (sessionId: string) => PendingSubmission;
  /**
   * Replaces the pending submission of `sessionId` and tells every
   * subscriber. An empty one, with no text and no picks, removes the entry.
   */
  readonly write: (sessionId: string, pending: PendingSubmission) => void;
  /** Calls `listener` after every write, until the returned function is called. */
  readonly subscribe: (listener: () => void) => () => void;
}

const EMPTY: PendingSubmission = { message: { text: "" }, picks: {} };

/** Creates an empty store. */
export const createPendingSubmissions = (): PendingSubmissions => {
  const entries = new Map<string, PendingSubmission>();
  const listeners = new Set<() => void>();
  return {
    read: (sessionId) => entries.get(sessionId) ?? EMPTY,
    write: (sessionId, pending) => {
      if (pending.message.text === "" && Object.keys(pending.picks).length === 0) {
        entries.delete(sessionId);
      } else {
        entries.set(sessionId, pending);
      }
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
