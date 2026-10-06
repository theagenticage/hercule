/**
 * The thread's Request drafts: per open Request, the answers typed so far
 * and whether one was sent, and which Request the dock shows.
 *
 * The drafts live in this module, keyed by the thread's session id, and each
 * reader subscribes to the one value it shows. A keystroke in one Request's
 * answers changes only that Request's draft, so only its dock renders again,
 * not the pager or the docks of other Requests.
 *
 * The thread's layout route keeps the drafts (`useThreadRequestDrafts`),
 * because it stays mounted while the user moves between the thread's page
 * and its subagents' pages. The dock unmounts on each move, so drafts kept
 * in its own state would be lost. Where no layout keeps the thread's drafts,
 * such as in the Office's thread drawer, each reader keeps its own state.
 *
 * The composer's Message Draft and picks are not here: the controller's
 * `pendingSubmissions` keeps them per thread for the whole app run.
 *
 * The drafts live in memory only. Leaving the thread drops them.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useMatch } from "@tanstack/react-router";
import {
  EMPTY_REQUEST_DRAFT,
  changeRequestDraft,
  dropClosedRequestDrafts,
  type RequestDraft,
} from "@hercule/client-core";
import type { SessionRequest } from "@hercule/contract";

interface ThreadDrafts {
  /** The drafts of the thread's open Requests, by requestId. */
  readonly requests: ReadonlyMap<string, RequestDraft>;
  /** The Request the user paged the dock to; undefined until the user pages. */
  readonly shownRequestId: string | undefined;
}

const EMPTY_THREAD_DRAFTS: ThreadDrafts = { requests: new Map(), shownRequestId: undefined };

/** The drafts of each thread a mounted layout keeps, by session id. */
const threadDrafts = new Map<string, ThreadDrafts>();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const notifyListeners = (): void => {
  for (const listener of listeners) listener();
};

/**
 * Replaces the drafts of the thread `sessionId` with `change` applied to
 * them, and tells every reader. Does nothing once no layout keeps the
 * thread's drafts: an answer that fails after the user left the thread must
 * not bring its drafts back.
 */
const changeThreadDrafts = (
  sessionId: string,
  change: (drafts: ThreadDrafts) => ThreadDrafts,
): void => {
  const current = threadDrafts.get(sessionId);
  if (current === undefined) return;
  const next = change(current);
  if (next === current) return;
  threadDrafts.set(sessionId, next);
  notifyListeners();
};

/**
 * Returns the session id of the thread whose route the caller is drawn in,
 * or undefined outside it. The Office's thread drawer draws the thread's
 * page without the thread's route.
 */
const useThreadSessionId = (): string | undefined =>
  useMatch({
    from: "/_connected/_shell/threads/$sessionId",
    shouldThrow: false,
    select: (match) => match.params.sessionId,
  });

/**
 * Keeps the drafts of the thread `sessionId` while the caller is mounted.
 * The thread's layout route calls it.
 *
 * - The draft of a Request is dropped once the Request is no longer among
 *   the session's `openRequests`.
 * - Every draft of the thread is dropped when the caller unmounts or moves
 *   to another session, so leaving the thread forgets what was typed.
 */
export function useThreadRequestDrafts(
  sessionId: string,
  openRequests: readonly SessionRequest[],
): void {
  // This effect is declared first so that, on mount, the thread's drafts
  // exist before the next effect prunes them.
  useEffect(() => {
    threadDrafts.set(sessionId, EMPTY_THREAD_DRAFTS);
    notifyListeners();
    return () => {
      threadDrafts.delete(sessionId);
      notifyListeners();
    };
  }, [sessionId]);
  // A closed Request's dock is no longer drawn, so pruning after the render
  // shows nothing stale.
  useEffect(() => {
    changeThreadDrafts(sessionId, (drafts) => dropClosedRequestDrafts(drafts, openRequests));
  }, [sessionId, openRequests]);
}

/**
 * Returns the draft of the open Request `requestId` and a function that
 * changes it. A Request the user has not touched has the empty draft.
 * Renders the caller again only when this Request's draft changes.
 *
 * Where no layout keeps the thread's drafts, the draft is the caller's own
 * state. The Office's thread drawer draws the thread's page without the
 * thread's layout, and never moves to another of the thread's pages, so its
 * dock has nothing to keep across a move.
 */
export function useRequestDraft(
  requestId: string,
): readonly [RequestDraft, (change: (draft: RequestDraft) => RequestDraft) => void] {
  const sessionId = useThreadSessionId();
  const [ownDraft, setOwnDraft] = useState(EMPTY_REQUEST_DRAFT);
  // Null while no layout keeps the thread's drafts.
  const threadDraft = useSyncExternalStore(subscribe, () => {
    const drafts = sessionId === undefined ? undefined : threadDrafts.get(sessionId);
    return drafts === undefined ? null : (drafts.requests.get(requestId) ?? EMPTY_REQUEST_DRAFT);
  });
  if (sessionId === undefined || threadDraft === null) return [ownDraft, setOwnDraft];
  return [
    threadDraft,
    (change) => {
      changeThreadDrafts(sessionId, (drafts) => changeRequestDraft(drafts, requestId, change));
    },
  ];
}

/**
 * Returns the id of the Request the user paged the dock to, undefined until
 * the user pages, and a function that changes it. The dock passes it to
 * `buildRequestDock`, which falls back to the oldest Request when the id is
 * no longer open.
 *
 * Where no layout keeps the thread's drafts, the id is the caller's own
 * state, as the draft is in `useRequestDraft`.
 */
export function useShownRequestId(): readonly [
  string | undefined,
  (requestId: string | undefined) => void,
] {
  const sessionId = useThreadSessionId();
  const [ownShownRequestId, setOwnShownRequestId] = useState<string | undefined>(undefined);
  // Null while no layout keeps the thread's drafts.
  const threadShownRequestId = useSyncExternalStore(subscribe, () => {
    const drafts = sessionId === undefined ? undefined : threadDrafts.get(sessionId);
    return drafts === undefined ? null : drafts.shownRequestId;
  });
  if (sessionId === undefined || threadShownRequestId === null) {
    return [ownShownRequestId, setOwnShownRequestId];
  }
  return [
    threadShownRequestId,
    (shownRequestId) => {
      changeThreadDrafts(sessionId, (drafts) => ({ ...drafts, shownRequestId }));
    },
  ];
}
