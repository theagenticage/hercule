/**
 * A thread's per-Request drafts: what the user has done so far on each open
 * Request. Both apps hold them by requestId, change one at a time, and drop
 * each once the controller closes its Request.
 */
import type { SessionRequest } from "@hercule/contract";
import type { QuestionDraft } from "./question-draft";

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

/** The draft of a Request the user has not touched yet. */
export const EMPTY_REQUEST_DRAFT: RequestDraft = {
  answered: false,
  question: null,
  shownQuestionIndex: 0,
};

/**
 * Returns `drafts` with the draft of the Request `requestId` replaced by
 * `change` applied to it. A Request without a draft starts from
 * `EMPTY_REQUEST_DRAFT`.
 *
 * `drafts.requests` holds the drafts by requestId. Any other field of
 * `drafts` is copied unchanged, and the drafts of other Requests keep their
 * identity, so a reader of one Request's draft sees no change when another
 * Request's draft changes.
 */
export const changeRequestDraft = <
  Drafts extends { readonly requests: ReadonlyMap<string, RequestDraft> },
>(
  drafts: Drafts,
  requestId: string,
  change: (draft: RequestDraft) => RequestDraft,
): Drafts => {
  const requests = new Map(drafts.requests);
  requests.set(requestId, change(drafts.requests.get(requestId) ?? EMPTY_REQUEST_DRAFT));
  return { ...drafts, requests };
};

/**
 * Returns `drafts` without the drafts of Requests that are not among
 * `openRequests`. Returns `drafts` itself when there is none to drop, so a
 * caller can tell by identity that nothing changed.
 *
 * `drafts.requests` holds the drafts by requestId. Any other field of
 * `drafts` is copied unchanged.
 */
export const dropClosedRequestDrafts = <
  Drafts extends { readonly requests: ReadonlyMap<string, unknown> },
>(
  drafts: Drafts,
  openRequests: readonly SessionRequest[],
): Drafts => {
  const closed = [...drafts.requests.keys()].filter(
    (id) => !openRequests.some((request) => request.requestId === id),
  );
  if (closed.length === 0) return drafts;
  const requests = new Map(drafts.requests);
  for (const id of closed) requests.delete(id);
  return { ...drafts, requests };
};
