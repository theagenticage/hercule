/**
 * The thread's drafts: what the user has typed or picked on a thread and not
 * sent yet. That is the composer's Message Draft and unsent picks, and, per
 * open Request, the answer being written and whether one was sent. It also
 * holds the Request the user paged the dock to, because the composer must
 * know which Request the dock shows to answer its question.
 *
 * The thread's layout route provides the drafts, because it stays mounted
 * while the user moves between the thread's page and its subagents' pages.
 * The composer and the Request dock unmount on each move, so drafts kept in
 * their own state would be lost.
 *
 * The drafts live in memory only. Leaving the thread drops them.
 */
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  EMPTY_REQUEST_DRAFT,
  changeRequestDraft,
  dropClosedRequestDrafts,
  isAnswerSendRunning,
  readErrorMessage,
  type HerculeClient,
  type MessageDraft,
  type RequestDraft,
  type ThreadPicks,
} from "@hercule/client-core";
import type { QuestionAnswers, SessionRequest } from "@hercule/contract";

/** The composer's unsent input: the Message Draft, with its text and images, and the picks not yet sent. */
export interface ComposerDraft {
  readonly message: MessageDraft;
  readonly picks: ThreadPicks;
}

interface ThreadDrafts {
  readonly composer: ComposerDraft;
  /** The drafts of the thread's open Requests, by requestId. */
  readonly requests: ReadonlyMap<string, RequestDraft>;
  /**
   * The Request the user paged the dock to; undefined until they page. When
   * it is no longer open, the dock shows the oldest open Request instead.
   */
  readonly shownRequestId: string | undefined;
}

interface ThreadDraftsStore {
  readonly drafts: ThreadDrafts;
  readonly update: (change: (drafts: ThreadDrafts) => ThreadDrafts) => void;
  /**
   * Returns the drafts as they are right now, including changes made since
   * the last render. A callback that decides from the drafts, such as the
   * duplicate-send guard, reads them here rather than from the render it
   * was created in.
   */
  readonly read: () => ThreadDrafts;
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
    shownRequestId: undefined,
  });
  // The drafts as of the last `update`, which `read` returns. State alone
  // would give the render's snapshot. The effect brings the ref in line with
  // the state after a render, which also covers the pruning below.
  const latest = useRef(drafts);
  useEffect(() => {
    latest.current = drafts;
  }, [drafts]);
  const update = (change: (drafts: ThreadDrafts) => ThreadDrafts): void => {
    latest.current = change(latest.current);
    setDrafts(change);
  };
  // The drafts are pruned while rendering, the way React advises to adjust
  // state when a prop changes, rather than in an effect, which would render
  // the closed Requests' drafts once more first.
  const [prunedFor, setPrunedFor] = useState(openRequests);
  if (openRequests !== prunedFor) {
    setPrunedFor(openRequests);
    setDrafts((current) => dropClosedRequestDrafts(current, openRequests));
  }
  return (
    <ThreadDraftsContext.Provider value={{ drafts, update, read: () => latest.current }}>
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
 * Pass `null` when there is no Request, such as in a draft thread, which has
 * no Requests and no thread drafts: the draft is then the empty one and the
 * function changes nothing. Fails when a Request is given and no thread
 * provides drafts: a Request is only ever shown inside its thread.
 */
export function useRequestDraft(
  requestId: string | null,
): readonly [RequestDraft, (change: (draft: RequestDraft) => RequestDraft) => void] {
  const store = useContext(ThreadDraftsContext);
  if (requestId === null) return [EMPTY_REQUEST_DRAFT, () => {}];
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

/**
 * Returns the id of the Request the user paged the dock to, undefined until
 * they page, and a function that pages to another Request. The dock and the
 * composer both pass the id to `buildRequestDock`, which falls back to the
 * oldest Request when the id is no longer open, so they always agree on the
 * Request that is shown.
 *
 * In a draft thread, which has no thread drafts and no Requests, the id is
 * undefined and the function changes nothing.
 */
export function useShownRequestId(): readonly [string | undefined, (requestId: string) => void] {
  const store = useContext(ThreadDraftsContext);
  if (store === null) return [undefined, () => {}];
  return [
    store.drafts.shownRequestId,
    (shownRequestId) => {
      store.update((drafts) => ({ ...drafts, shownRequestId }));
    },
  ];
}

/** What a send of answers carries, which is also the mutation's variables. */
interface SentAnswers {
  readonly requestId: string;
  readonly answers: QuestionAnswers;
}

/**
 * Returns the function that sends the answers to the `question` Request
 * `requestId` of the session `sessionId` with `session.respondToQuestion`.
 * The dock and the composer both send through it, so they agree on when a
 * Request counts as answered and on how a failure shows.
 *
 * - A send does nothing while another send for the same Request is running,
 *   even one started by another component, or once the Request's draft says
 *   it was answered. Two quick presses of Enter therefore send once. Other
 *   Requests send independently.
 * - The Request's draft is `answered` from the start of a send and `failure`
 *   is cleared. When the send fails, `answered` turns false again and
 *   `failure` holds the error message, so the user can answer again with
 *   every answer kept. The callbacks run even after the component that sent
 *   has unmounted.
 * - The response is not written into the cache. It is a snapshot of the
 *   session from when the controller received the answers, still parked on
 *   the Request, so writing it would bring back a card the live `session`
 *   topic has already cleared. That topic is the source of truth; until it
 *   clears the Request, the draft's `answered` keeps the Request locked.
 *
 * Pass `null` as `sessionId` in a draft thread, which has no Requests: the
 * returned function then does nothing. Fails when a session is given and no
 * thread provides drafts.
 */
export function useSendAnswers(
  client: HerculeClient,
  sessionId: string | null,
): (requestId: string, answers: QuestionAnswers) => void {
  const store = useContext(ThreadDraftsContext);
  const queryClient = useQueryClient();
  const mutationKey = ["session", sessionId, "respond-to-question"];
  const changeRequest = (
    requestId: string,
    change: (draft: RequestDraft) => RequestDraft,
  ): void => {
    store?.update((drafts) => changeRequestDraft(drafts, requestId, change));
  };
  const send = useMutation({
    mutationKey,
    mutationFn: (sent: SentAnswers) =>
      client.session.respondToQuestion({
        params: { id: sessionId! },
        payload: sent,
      }),
    onMutate: (sent) => {
      changeRequest(sent.requestId, (draft) => ({ ...draft, answered: true, failure: null }));
    },
    onError: (error, sent) => {
      changeRequest(sent.requestId, (draft) => ({
        ...draft,
        answered: false,
        failure: readErrorMessage(error),
      }));
    },
  });
  return (requestId, answers) => {
    if (sessionId === null) return;
    if (store === null) {
      throw new Error("useSendAnswers was called outside a ThreadDraftsProvider.");
    }
    // The mutation cache knows at once that a send started, while the draft
    // only changes with the next render.
    if (
      isAnswerSendRunning(queryClient, mutationKey, requestId) ||
      store.read().requests.get(requestId)?.answered === true
    ) {
      return;
    }
    send.mutate({ requestId, answers });
  };
}
