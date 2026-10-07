/**
 * A session's Request drafts: per open Request, the answers typed so far
 * and whether one was sent, and which Request the dock shows. The session is
 * a thread's, or the current session of an assistant's Conversation.
 *
 * The drafts live in this module, keyed by the session id, and each reader
 * subscribes to the one value it shows. A keystroke in one Request's answers
 * changes only that Request's draft, so only its dock renders again, not
 * the pager or the docks of other Requests.
 *
 * A session's drafts exist while something that shows the session keeps
 * them (`useKeepRequestDrafts`). The dock itself cannot keep them, because
 * it unmounts whenever the user pages to another Request or moves to
 * another of the thread's pages. The keepers are:
 *
 * - the thread's layout route, which stays mounted while the user moves
 *   between the thread's page and its subagents' pages;
 * - in the Office, the dossier card and the thread drawer, which show the
 *   same thread, so an answer started on the card is still there in the
 *   drawer;
 * - an assistant's page, for its current session.
 *
 * Several keepers may keep one session at once. Its drafts are dropped when
 * the last of them lets go, so leaving the thread or the assistant forgets
 * what was typed. Drafts of Requests that closed meanwhile stay until then:
 * no dock shows a closed Request, and a requestId is never opened again.
 *
 * A reader of a session that nobody keeps reads the empty draft, and its
 * changes are dropped. This is what an answer that fails after the user left
 * must do: it must not bring the session's drafts back.
 *
 * The composer's Message Draft and picks are not here: the controller's
 * `pendingSubmissions` keeps them per thread and per assistant for the whole
 * app run.
 *
 * The drafts live in memory only.
 */
import { useEffect, useSyncExternalStore } from "react";
import { EMPTY_REQUEST_DRAFT, changeRequestDraft, type RequestDraft } from "@hercule/client-core";

interface SessionDrafts {
  /** The drafts of the session's Requests, by requestId. */
  readonly requests: ReadonlyMap<string, RequestDraft>;
  /** The Request the user paged the dock to; undefined until the user pages. */
  readonly shownRequestId: string | undefined;
}

interface KeptSession {
  /** How many mounted keepers keep the session's drafts. */
  readonly keepers: number;
  readonly drafts: SessionDrafts;
}

const EMPTY_SESSION_DRAFTS: SessionDrafts = { requests: new Map(), shownRequestId: undefined };

/** The sessions whose drafts are kept, by session id. */
const keptSessions = new Map<string, KeptSession>();
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
 * Replaces the drafts of the session `sessionId` with `change` applied to
 * them, and tells every reader. Does nothing while nobody keeps the session.
 */
const changeSessionDrafts = (
  sessionId: string,
  change: (drafts: SessionDrafts) => SessionDrafts,
): void => {
  const kept = keptSessions.get(sessionId);
  if (kept === undefined) return;
  const drafts = change(kept.drafts);
  if (drafts === kept.drafts) return;
  keptSessions.set(sessionId, { ...kept, drafts });
  notifyListeners();
};

/** Returns the drafts of the session `sessionId`, or the empty drafts while nobody keeps it. */
const readSessionDrafts = (sessionId: string): SessionDrafts =>
  keptSessions.get(sessionId)?.drafts ?? EMPTY_SESSION_DRAFTS;

/**
 * Keeps the drafts of the session `sessionId` while the caller is mounted, or
 * keeps nothing when `sessionId` is null. The drafts are dropped once the
 * last keeper of the session unmounts or moves to another session.
 */
export function useKeepRequestDrafts(sessionId: string | null): void {
  useEffect(() => {
    if (sessionId === null) return;
    const kept = keptSessions.get(sessionId);
    keptSessions.set(sessionId, {
      keepers: (kept?.keepers ?? 0) + 1,
      drafts: kept?.drafts ?? EMPTY_SESSION_DRAFTS,
    });
    return () => {
      const current = keptSessions.get(sessionId);
      if (current === undefined) return;
      if (current.keepers > 1) {
        keptSessions.set(sessionId, { ...current, keepers: current.keepers - 1 });
        return;
      }
      keptSessions.delete(sessionId);
      notifyListeners();
    };
  }, [sessionId]);
}

/**
 * Returns the draft of the Request `requestId` of the session `sessionId`,
 * and a function that changes it. A Request the user has not touched has the
 * empty draft. Renders the caller again only when this Request's draft
 * changes.
 *
 * The function goes through the store rather than the caller's state, so it
 * still works after the caller unmounts, for as long as the session is kept.
 */
export function useRequestDraft(
  sessionId: string,
  requestId: string,
): readonly [RequestDraft, (change: (draft: RequestDraft) => RequestDraft) => void] {
  const draft = useSyncExternalStore(
    subscribe,
    () => readSessionDrafts(sessionId).requests.get(requestId) ?? EMPTY_REQUEST_DRAFT,
  );
  return [
    draft,
    (change) => {
      changeSessionDrafts(sessionId, (drafts) => changeRequestDraft(drafts, requestId, change));
    },
  ];
}

/**
 * Returns the id of the Request the user paged the dock of the session
 * `sessionId` to, undefined until the user pages, and a function that
 * changes it. The dock passes it to `buildRequestDock`, which falls back to
 * the oldest Request when the id is no longer open.
 */
export function useShownRequestId(
  sessionId: string,
): readonly [string | undefined, (requestId: string | undefined) => void] {
  const shownRequestId = useSyncExternalStore(
    subscribe,
    () => readSessionDrafts(sessionId).shownRequestId,
  );
  return [
    shownRequestId,
    (requestId) => {
      changeSessionDrafts(sessionId, (drafts) => ({ ...drafts, shownRequestId: requestId }));
    },
  ];
}
