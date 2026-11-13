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
import type { RecentModel, ShelfItem, ThreadPicks } from "@hercule/client-core";
import type { InboxThing, SessionSpawnInput } from "@hercule/contract";

/**
 * What one send carries to the controller, and what the screen needs once it
 * answers. It is built once, when the user sends, and never changed after.
 */
export interface SentThread {
  /** The key of the draft the send was made from. */
  readonly draftKey: string;
  /** The request, with the dedup key that makes sending it again safe. */
  readonly input: SessionSpawnInput;
  /** The new Task's name. */
  readonly title: string;
  readonly things: readonly InboxThing[];
  /** The images the send carries, which leave the shelf once it succeeds. */
  readonly attachments: readonly ShelfItem[];
  /** The model the user picked for this send, to remember in Recent once it succeeds, or `null`. */
  readonly recent: RecentModel | null;
  /** The line under the Task's name once the thread has started. */
  readonly summary: string;
}

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
   * The exact request of the last send, with its dedup key, while that send
   * failed or its answer is unknown: the controller may have made the thread.
   * "Try again" sends this request as it is, whatever the project match and
   * the picks are now, so the controller finds the thread it made. Any change
   * to the draft removes it, because the controller does not compare a repeat
   * with the first call.
   */
  readonly attempt: SentThread | undefined;
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
const buildThreadStartDraft = (things: readonly InboxThing[]): ThreadStartDraft => ({
  things,
  title: things[0]?.title ?? "",
  text: writeStarterMessage(DEFAULT_THREAD_STARTER, things),
  starter: DEFAULT_THREAD_STARTER,
  chosenProject: undefined,
  picks: {},
  attempt: undefined,
  isEdited: false,
  failure: null,
});

/**
 * Returns whether `draft` is worth keeping when its dialog closes: the user
 * changed it, or a send was attempted from it. An attempt counts even with no
 * change, because the controller may have made the thread while the answer was
 * lost, and only a retry with the same dedup key finds it again.
 */
const isWorthKeeping = (draft: ThreadStartDraft): boolean =>
  draft.isEdited || draft.attempt !== undefined || draft.failure !== null;

/** What the user can change in a draft: the words, the name, the chips, the project and the picks. */
export type ThreadStartDraftEdit = Partial<
  Pick<ThreadStartDraft, "things" | "title" | "text" | "starter" | "chosenProject" | "picks">
>;

/**
 * The unsent dialogs of one account scope, by `buildThingsDraftKey`. Every
 * change to a draft is a verb here, so the rules of its life (when a send
 * attempt is voided, when a draft is kept) are in one place. A verb on a key
 * that holds no draft does nothing.
 */
export interface ThreadStartDrafts {
  /** Returns the draft at `key`, or `undefined`. The same object comes back until the next change at `key`. */
  readonly read: (key: string) => ThreadStartDraft | undefined;
  /** Creates the draft at `key` for `things` when there is none. An existing draft stays as it is. */
  readonly open: (key: string, things: readonly InboxThing[]) => void;
  /**
   * Applies what the user changed. The draft is then no longer the one a send
   * was made from, so its `attempt` (and its dedup key) goes, and it counts as
   * edited. A change that is not in `patch`, such as an attached image, passes
   * `{}`. With `answersFailure`, the failed send's message goes too, for a
   * change that answers it.
   */
  readonly edit: (
    key: string,
    patch: ThreadStartDraftEdit,
    options?: { readonly answersFailure?: boolean },
  ) => void;
  /** Records the request being sent, so "Try again" sends it as it is. */
  readonly recordAttempt: (key: string, sent: SentThread) => void;
  /** Records why the last send failed, or `null` for no failure. */
  readonly recordFailure: (key: string, failure: string | null) => void;
  /**
   * Decides what becomes of the draft at `key` when its dialog closes, and
   * returns whether its words were kept for the user to open again.
   * - Once the thread started (`hasStarted`), the draft goes.
   * - While a send is on its way (`isStarting`), it stays: success finishes it
   *   and failure records its message.
   * - A draft worth keeping stays, see `ThreadStartDraft.isEdited` and `attempt`.
   * - Any other draft goes.
   */
  readonly settle: (
    key: string,
    state: { readonly isStarting: boolean; readonly hasStarted: boolean },
  ) => boolean;
  /** Removes the draft at `key`, because its thread started or its dialog ended. */
  readonly finish: (key: string) => void;
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
  /** Replaces the draft at `key` by `change` of it, when there is one. */
  const update = (key: string, change: (draft: ThreadStartDraft) => ThreadStartDraft): void => {
    const draft = drafts.get(key);
    if (draft === undefined) return;
    drafts.set(key, change(draft));
    tell();
  };
  const finish = (key: string): void => {
    if (drafts.delete(key)) tell();
  };
  return {
    read: (key) => drafts.get(key),
    open: (key, things) => {
      if (drafts.has(key)) return;
      drafts.set(key, buildThreadStartDraft(things));
      tell();
    },
    edit: (key, patch, options) => {
      update(key, (draft) => ({
        ...draft,
        ...patch,
        attempt: undefined,
        isEdited: true,
        ...(options?.answersFailure === true ? { failure: null } : {}),
      }));
    },
    recordAttempt: (key, sent) => {
      update(key, (draft) => ({ ...draft, attempt: sent }));
    },
    recordFailure: (key, failure) => {
      update(key, (draft) => ({ ...draft, failure }));
    },
    settle: (key, { isStarting, hasStarted }) => {
      const draft = drafts.get(key);
      if (draft === undefined) return false;
      if (hasStarted) {
        finish(key);
        return false;
      }
      if (isStarting) return false;
      if (isWorthKeeping(draft)) return true;
      finish(key);
      return false;
    },
    finish,
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
