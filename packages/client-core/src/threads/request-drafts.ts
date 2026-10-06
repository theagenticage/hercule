/**
 * Keeps a thread's per-Request drafts in step with the Requests that are
 * still open. Both apps hold what the user typed on each open Request, and
 * both drop it once the controller closes the Request.
 */
import type { SessionRequest } from "@hercule/contract";

/**
 * Returns `drafts` without the drafts of Requests that are not among
 * `openRequests`. Returns `drafts` itself when there is none to drop, so a
 * React state update with the result changes nothing.
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
