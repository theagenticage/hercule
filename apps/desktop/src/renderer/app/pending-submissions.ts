/**
 * The pending submissions: for each thread, each Draft Thread and each
 * assistant's Conversation, what the user has typed, attached and picked in
 * its composer and not sent yet.
 *
 * The store is held in memory for as long as the app runs, so a thread keeps
 * its unsent text, images and picks while the user looks at another thread, and
 * loses them at quit (spec 17 §The thread). It sits in the router context,
 * rather than in the composer, because the composer unmounts when the user
 * leaves the thread.
 */
import type { MessageDraft, ShelfItem, ThreadPicks } from "@hercule/client-core";

/** What one thread's composer holds and has not sent. */
export interface PendingSubmission {
  /** The text in the composer's field, and the images on its shelf. */
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
 * The pending submission of every thread, every Draft Thread and every
 * assistant's Conversation. A thread's key is its session id, a Draft
 * Thread's is `buildDraftKey`'s, and an assistant's is
 * `buildAssistantDraftKey`'s.
 *
 * Every change tells every subscriber. A change that leaves no text, no
 * images, no picks and no failure at `key` removes its entry.
 */
export interface PendingSubmissions {
  /**
   * Returns the pending submission at `key`, or an empty one when there is
   * none. The same object comes back until the next change at `key`, as
   * React's `useSyncExternalStore` requires.
   */
  readonly read: (key: string) => PendingSubmission;
  /** Replaces the text at `key`, and keeps its images, its picks and its failure. */
  readonly writeText: (key: string, text: string) => void;
  /**
   * Replaces the images at `key` with what `update` returns for the images
   * there now. An upload that ends after the user changed the shelf changes
   * the shelf as it is then, not as it was when the upload started.
   */
  readonly updateAttachments: (
    key: string,
    update: (shelf: readonly ShelfItem[]) => readonly ShelfItem[],
  ) => void;
  /** Replaces the picks at `key`, and keeps its text and its failure. */
  readonly writePicks: (key: string, picks: ThreadPicks) => void;
  /** Records at `key` that its submission failed with `message`. */
  readonly recordFailure: (key: string, message: string) => void;
  /** Removes the failure at `key`, as a new submission starts. Does nothing when there is none. */
  readonly clearFailure: (key: string) => void;
  /**
   * Clears what a submission that succeeded sent from `key`: the text, if it
   * is still `sent.text`, the images in `sent.attachments`, and the picks,
   * if no pick was made since, so they are still the object `sent.picks`.
   * Also removes the failure, since the submission succeeded.
   *
   * What was typed or picked while the submission was on its way belongs to
   * the next one, so it stays.
   */
  readonly clearSent: (
    key: string,
    sent: {
      readonly text: string;
      readonly attachments: readonly ShelfItem[];
      readonly picks: ThreadPicks;
    },
  ) => void;
  /** Calls `listener` after every change, until the returned function is called. */
  readonly subscribe: (listener: () => void) => () => void;
}

const EMPTY: PendingSubmission = { message: { text: "", attachments: [] }, picks: {} };

/**
 * Returns the store key of the Draft Thread in `projectId` that joins
 * `workspaceId`, such as `draft:<project id>:-` for a draft in a project
 * that joins no workspace. Each place a thread can be started from keeps its
 * own draft. The prefix keeps a draft's key apart from every session id.
 */
export const buildDraftKey = (projectId: string | null, workspaceId: string | null): string =>
  `draft:${projectId ?? "-"}:${workspaceId ?? "-"}`;

/**
 * Returns the store key of the Message Draft in the Conversation of the
 * assistant `assistantId`, such as `assistant:<assistant id>`. The draft is
 * kept per assistant rather than per session, because the session behind a
 * Conversation can change while the user writes. The prefix keeps the key
 * apart from every session id and every `buildDraftKey` key.
 */
export const buildAssistantDraftKey = (assistantId: string): string => `assistant:${assistantId}`;

/** Creates an empty store. */
export const createPendingSubmissions = (): PendingSubmissions => {
  const entries = new Map<string, PendingSubmission>();
  const listeners = new Set<() => void>();
  const read = (key: string): PendingSubmission => entries.get(key) ?? EMPTY;
  const write = (key: string, pending: PendingSubmission): void => {
    if (
      pending.message.text === "" &&
      pending.message.attachments.length === 0 &&
      Object.keys(pending.picks).length === 0 &&
      pending.failure === undefined
    ) {
      entries.delete(key);
    } else {
      entries.set(key, pending);
    }
    for (const listener of listeners) listener();
  };
  return {
    read,
    writeText: (key, text) => {
      const pending = read(key);
      write(key, { ...pending, message: { ...pending.message, text } });
    },
    updateAttachments: (key, update) => {
      const pending = read(key);
      const attachments = update(pending.message.attachments);
      if (attachments !== pending.message.attachments)
        write(key, { ...pending, message: { ...pending.message, attachments } });
    },
    writePicks: (key, picks) => {
      write(key, { ...read(key), picks });
    },
    recordFailure: (key, message) => {
      write(key, { ...read(key), failure: message });
    },
    clearFailure: (key) => {
      const { message, picks, failure } = read(key);
      if (failure !== undefined) write(key, { message, picks });
    },
    clearSent: (key, sent) => {
      const { message, picks } = read(key);
      const sentKeys = new Set(sent.attachments.map((item) => item.key));
      write(key, {
        message: {
          text: message.text === sent.text ? "" : message.text,
          attachments: message.attachments.filter((item) => !sentKeys.has(item.key)),
        },
        picks: picks === sent.picks ? {} : picks,
      });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
