/**
 * The pending submissions: for each thread, and for each Draft Thread, what
 * the user has typed and picked in its composer and not sent yet.
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
  /**
   * The message of the error the last submission failed with, absent when it
   * did not fail. It is kept here, rather than read from the request, so it
   * still shows when the user left before the request failed and came back.
   */
  readonly failure?: string;
}

/**
 * The pending submission of every thread and every Draft Thread. A thread's
 * key is its session id, and a Draft Thread's is `buildDraftKey`'s.
 */
export interface PendingSubmissions {
  /**
   * Returns the pending submission at `key`, or an empty one when there is
   * none. The same object comes back until the next `write` at `key`, as
   * React's `useSyncExternalStore` requires.
   */
  readonly read: (key: string) => PendingSubmission;
  /**
   * Replaces the pending submission at `key` and tells every subscriber. An
   * empty one, with no text, no picks and no failure, removes the entry.
   */
  readonly write: (key: string, pending: PendingSubmission) => void;
  /** Calls `listener` after every write, until the returned function is called. */
  readonly subscribe: (listener: () => void) => () => void;
}

const EMPTY: PendingSubmission = { message: { text: "" }, picks: {} };

/**
 * Returns the store key of the Draft Thread in `projectId` that joins
 * `workspaceId`, such as `draft:<project id>:-` for a draft in a project
 * that joins no workspace. Each place a thread can be started from keeps its
 * own draft. The prefix keeps a draft's key apart from every session id.
 */
export const buildDraftKey = (projectId: string | null, workspaceId: string | null): string =>
  `draft:${projectId ?? "-"}:${workspaceId ?? "-"}`;

/** Creates an empty store. */
export const createPendingSubmissions = (): PendingSubmissions => {
  const entries = new Map<string, PendingSubmission>();
  const listeners = new Set<() => void>();
  return {
    read: (key) => entries.get(key) ?? EMPTY,
    write: (key, pending) => {
      if (
        pending.message.text === "" &&
        Object.keys(pending.picks).length === 0 &&
        pending.failure === undefined
      ) {
        entries.delete(key);
      } else {
        entries.set(key, pending);
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
