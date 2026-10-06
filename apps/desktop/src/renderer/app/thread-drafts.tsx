/**
 * The thread's Request drafts: per open Request, the answers typed so far
 * and whether one was sent, and which Request the dock shows.
 *
 * The thread's layout route provides them, because it stays mounted while
 * the user moves between the thread's page and its subagents' pages. The
 * dock unmounts on each move, so drafts kept in its own state would be lost.
 *
 * The composer's Message Draft and picks are not here: the controller's
 * `pendingSubmissions` keeps them per thread for the whole app run.
 *
 * The drafts live in memory only. Leaving the thread drops them.
 */
import { createContext, useContext, useState, type JSX, type ReactNode } from "react";
import { dropClosedRequestDrafts, type QuestionDraft } from "@hercule/client-core";
import type { SessionRequest } from "@hercule/contract";

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
  /** The drafts of the thread's open Requests, by requestId. */
  readonly requests: ReadonlyMap<string, RequestDraft>;
  /** The Request the user paged the dock to; undefined until the user pages. */
  readonly shownRequestId: string | undefined;
}

interface ThreadDraftsStore {
  readonly drafts: ThreadDrafts;
  readonly update: (change: (drafts: ThreadDrafts) => ThreadDrafts) => void;
}

const EMPTY_REQUEST_DRAFT: RequestDraft = {
  answered: false,
  question: null,
  shownQuestionIndex: 0,
};

const EMPTY_THREAD_DRAFTS: ThreadDrafts = { requests: new Map(), shownRequestId: undefined };

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
  const [drafts, setDrafts] = useState(EMPTY_THREAD_DRAFTS);
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
 * Returns the thread's drafts and a function that changes them.
 *
 * Outside a `ThreadDraftsProvider` they are the caller's own state. The
 * Office's thread drawer draws the thread's page without the thread's
 * route, and never moves to another of the thread's pages, so its dock has
 * nothing to keep across a move.
 */
const useThreadDrafts = (): ThreadDraftsStore => {
  const store = useContext(ThreadDraftsContext);
  const [ownDrafts, setOwnDrafts] = useState(EMPTY_THREAD_DRAFTS);
  return store ?? { drafts: ownDrafts, update: setOwnDrafts };
};

/**
 * Returns the draft of the open Request `requestId` and a function that
 * changes it. A Request the user has not touched has the empty draft.
 */
export function useRequestDraft(
  requestId: string,
): readonly [RequestDraft, (change: (draft: RequestDraft) => RequestDraft) => void] {
  const { drafts, update } = useThreadDrafts();
  return [
    drafts.requests.get(requestId) ?? EMPTY_REQUEST_DRAFT,
    (change) => {
      update((current) => {
        const requests = new Map(current.requests);
        requests.set(requestId, change(current.requests.get(requestId) ?? EMPTY_REQUEST_DRAFT));
        return { ...current, requests };
      });
    },
  ];
}

/**
 * Returns the id of the Request the user paged the dock to, undefined until
 * the user pages, and a function that changes it. The dock passes it to
 * `buildRequestDock`, which falls back to the oldest Request when the id is
 * no longer open.
 */
export function useShownRequestId(): readonly [
  string | undefined,
  (requestId: string | undefined) => void,
] {
  const { drafts, update } = useThreadDrafts();
  return [
    drafts.shownRequestId,
    (shownRequestId) => {
      update((current) => ({ ...current, shownRequestId }));
    },
  ];
}
