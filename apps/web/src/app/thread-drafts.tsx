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
import type { QuestionDraft, ThreadPicks } from "@hercule/client-core";
import type { SessionRequest } from "@hercule/contract";

/** The composer's unsent input: the Message Draft and the picks not yet sent. */
export interface ComposerDraft {
  readonly message: string;
  readonly picks: ThreadPicks;
}

/** What the user has done so far on one open Request. */
export interface RequestDraft {
  /**
   * Whether an answer was sent. It stays true until the controller closes the
   * Request, so the Request is not answered twice, and turns false again when
   * sending fails.
   */
  readonly answered: boolean;
  /** The answers to a `question` Request typed so far; null until the user gives one. */
  readonly question: QuestionDraft | null;
  /** The question of a `question` Request that is shown, from 0. */
  readonly shownQuestionIndex: number;
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

const EMPTY_COMPOSER_DRAFT: ComposerDraft = { message: "", picks: {} };

const EMPTY_REQUEST_DRAFT: RequestDraft = {
  answered: false,
  question: null,
  shownQuestionIndex: 0,
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
 * Returns `drafts` without the drafts of Requests that are not among
 * `openRequests`, or `drafts` itself when there is none to drop.
 */
function dropClosedRequestDrafts(
  drafts: ThreadDrafts,
  openRequests: readonly SessionRequest[],
): ThreadDrafts {
  const closed = [...drafts.requests.keys()].filter(
    (id) => !openRequests.some((request) => request.requestId === id),
  );
  if (closed.length === 0) return drafts;
  const requests = new Map(drafts.requests);
  for (const id of closed) requests.delete(id);
  return { ...drafts, requests };
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
      store.update((drafts) => {
        const requests = new Map(drafts.requests);
        requests.set(requestId, change(drafts.requests.get(requestId) ?? EMPTY_REQUEST_DRAFT));
        return { ...drafts, requests };
      });
    },
  ];
}
