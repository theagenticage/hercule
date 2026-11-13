/**
 * The unsent start-thread dialogs of the Inbox: for each set of things, what
 * the user has written and chosen in the dialog and has not sent yet.
 *
 * The store belongs to one account scope (`AccountScope.threadStarts`), so a
 * draft survives the user leaving the Inbox and coming back, and goes at
 * sign-out. Nothing is saved to disk. The images the user attached stay in the
 * pending submissions, under the same key, because the composer's image shelf
 * lives there.
 */
import {
  DEFAULT_THREAD_STARTER,
  writeStarterMessage,
  type ThreadStarter,
} from "@hercule/client-core/inbox";
import type { ThreadPicks } from "@hercule/client-core";
import type { InboxThing } from "@hercule/contract";

/** What one start-thread dialog holds and has not sent. */
export interface ThreadStartDraft {
  /** The things the thread starts from now: the set the dialog opened with, less the chips the user left out. */
  readonly things: readonly InboxThing[];
  /** The name the new Task gets. */
  readonly title: string;
  /** The message in the composer's field. */
  readonly text: string;
  /** The starter whose words the message holds, or `own` once the user wrote their own. */
  readonly starter: ThreadStarter;
  /**
   * The project the user chose: its id, `null` for "No project", or
   * `undefined` when the user chose nothing and the controller's match decides.
   */
  readonly chosenProject: string | null | undefined;
  /** The model, options, access mode and other picks the user made in the composer. */
  readonly picks: ThreadPicks;
  /**
   * The key that makes a send safe to repeat. It is made on the first send and
   * kept for the retries of that send. Any change to the draft removes it,
   * because the controller does not compare a repeat with the first call.
   */
  readonly dedupKey: string | undefined;
  /**
   * Whether the user changed anything: the words, the name, a chip, the
   * project, a pick or an image. A draft the user did not change is not worth
   * keeping when the dialog closes.
   */
  readonly isEdited: boolean;
  /** Why the last send failed, as the composer shows it, or `null`. */
  readonly failure: string | null;
}

/**
 * Returns the draft of a dialog that opens on `things`: the first thing's
 * name as the Task's name, and the default starter's words.
 */
export const buildThreadStartDraft = (things: readonly InboxThing[]): ThreadStartDraft => ({
  things,
  title: things[0]?.title ?? "",
  text: writeStarterMessage(DEFAULT_THREAD_STARTER, things),
  starter: DEFAULT_THREAD_STARTER,
  chosenProject: undefined,
  picks: {},
  dedupKey: undefined,
  isEdited: false,
  failure: null,
});

/** The unsent dialogs of one account scope, by `buildThingsDraftKey`. */
export interface ThreadStartDrafts {
  /** Returns the draft at `key`, or `undefined`. The same object comes back until the next change at `key`. */
  readonly read: (key: string) => ThreadStartDraft | undefined;
  /** Replaces the draft at `key`. */
  readonly write: (key: string, draft: ThreadStartDraft) => void;
  /** Removes the draft at `key`. Does nothing when there is none. */
  readonly drop: (key: string) => void;
  /** Removes every draft, as sign-out does. */
  readonly clear: () => void;
  /** Calls `listener` after every change, until the returned function is called. */
  readonly subscribe: (listener: () => void) => () => void;
}

/** Creates an empty store. */
export const createThreadStartDrafts = (): ThreadStartDrafts => {
  const drafts = new Map<string, ThreadStartDraft>();
  const listeners = new Set<() => void>();
  const tell = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    read: (key) => drafts.get(key),
    write: (key, draft) => {
      drafts.set(key, draft);
      tell();
    },
    drop: (key) => {
      if (drafts.delete(key)) tell();
    },
    clear: () => {
      drafts.clear();
      tell();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
