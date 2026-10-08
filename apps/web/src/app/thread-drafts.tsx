/**
 * The thread's drafts: what the user has typed or picked on a thread and not
 * sent yet. That is the composer's Message Draft and unsent picks, and, per
 * open Request, the answer being written and whether one was sent.
 *
 * The thread's layout route provides the drafts, because it stays mounted
 * while the user moves between the thread's page and its subagents' pages.
 * The composer and the Request dock unmount on each move, so drafts kept in
 * their own state would be lost.
 *
 * The drafts live in memory only. Leaving the thread drops them.
 */
import { createContext, useContext, useState, type JSX, type ReactNode } from "react";
import {
  EMPTY_REQUEST_DRAFT,
  changeRequestDraft,
  dropClosedRequestDrafts,
  type MessageDraft,
  type RequestDraft,
  type ThreadPicks,
} from "@hercule/client-core";
import type { SessionRequest } from "@hercule/contract";

/** The composer's unsent input: the Message Draft, with its text and images, and the picks not yet sent. */
export interface ComposerDraft {
  readonly message: MessageDraft;
  readonly picks: ThreadPicks;
}

interface ThreadDrafts {
  readonly composer: ComposerDraft;
  /** The drafts of the thread's open Requests, by requestId. */
  readonly requests: ReadonlyMap<string, RequestDraft>;
}

interface ThreadDraftsStore {
  readonly drafts: ThreadDrafts;
  readonly update: (change: (drafts: ThreadDrafts) => ThreadDrafts) => void;
}

const EMPTY_COMPOSER_DRAFT: ComposerDraft = {
  message: { text: "", attachments: [] },
  picks: {},
};

const ThreadDraftsContext = createContext<ThreadDraftsStore | null>(null);

/**
 * Provides the drafts of one thread to the pages below it. Give it the
 * thread's session id as its `key`, so one thread's drafts never show on
 * another.
 *
 * The draft of a Request is dropped once the Request is no longer among the
 * session's `openRequests`.
 */
export function ThreadDraftsProvider({
  openRequests,
  children,
}: {
  readonly openRequests: readonly SessionRequest[];
  readonly children: ReactNode;
}): JSX.Element {
  const [drafts, setDrafts] = useState<ThreadDrafts>({
    composer: EMPTY_COMPOSER_DRAFT,
    requests: new Map(),
  });
  // The drafts are pruned while rendering, the way React advises to adjust
  // state when a prop changes, rather than in an effect, which would render
  // the closed Requests' drafts once more first.
  const [prunedFor, setPrunedFor] = useState(openRequests);
  if (openRequests !== prunedFor) {
    setPrunedFor(openRequests);
    setDrafts((current) => dropClosedRequestDrafts(current, openRequests));
  }
  return (
    <ThreadDraftsContext.Provider value={{ drafts, update: setDrafts }}>
      {children}
    </ThreadDraftsContext.Provider>
  );
}

/**
 * Returns the composer's draft and a function that changes it.
 *
 * Inside a thread the draft is the thread's, so it survives a visit to a
 * subagent's page. A draft thread has no thread layout, and its composer
 * never unmounts while the draft is open, so there the draft is the caller's
 * own state.
 */
export function useComposerDraft(): readonly [
  ComposerDraft,
  (change: (draft: ComposerDraft) => ComposerDraft) => void,
] {
  const store = useContext(ThreadDraftsContext);
  const [ownDraft, setOwnDraft] = useState(EMPTY_COMPOSER_DRAFT);
  if (store === null) return [ownDraft, setOwnDraft];
  return [
    store.drafts.composer,
    (change) => {
      store.update((drafts) => ({ ...drafts, composer: change(drafts.composer) }));
    },
  ];
}

/**
 * Returns the draft of the open Request `requestId` and a function that
 * changes it. A Request the user has not touched has the empty draft.
 *
 * Fails when no thread provides drafts: a Request is only ever shown inside
 * its thread.
 */
export function useRequestDraft(
  requestId: string,
): readonly [RequestDraft, (change: (draft: RequestDraft) => RequestDraft) => void] {
  const store = useContext(ThreadDraftsContext);
  if (store === null) {
    throw new Error("useRequestDraft was called outside a ThreadDraftsProvider.");
  }
  return [
    store.drafts.requests.get(requestId) ?? EMPTY_REQUEST_DRAFT,
    (change) => {
      store.update((drafts) => changeRequestDraft(drafts, requestId, change));
    },
  ];
}
