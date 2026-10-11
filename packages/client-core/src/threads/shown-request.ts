/**
 * Decides which of a session's open requests the Requests dock shows, and
 * where the pager above the dock can page to from there. The agent Requests
 * and the Permission Requests page the same way.
 */

/** The request the dock shows, and its place among the open ones. */
export interface ShownRequest<Request> {
  readonly request: Request;
  /** Where the shown request is among the open ones, counted from 1. Null when only one is open. */
  readonly position: { readonly at: number; readonly of: number } | null;
  /** The request the pager's back arrow shows; undefined on the first one. */
  readonly previousRequestId: string | undefined;
  /** The request the pager's forward arrow shows; undefined on the last one. */
  readonly nextRequestId: string | undefined;
}

/**
 * Returns the request of `requests` (oldest first) whose id is
 * `shownRequestId`, with its place among them, or null when `requests` is
 * empty. When no request has that id, because the one the user paged to has
 * closed or none was named, it returns the oldest. `readId` reads a
 * request's id, which each kind of request keeps in its own field.
 */
export const locateShownRequest = <Request>(
  requests: readonly Request[],
  readId: (request: Request) => string,
  shownRequestId: string | undefined,
): ShownRequest<Request> | null => {
  const found = requests.findIndex((request) => readId(request) === shownRequestId);
  const index = found === -1 ? 0 : found;
  const request = requests[index];
  if (request === undefined) return null;
  const previous = index > 0 ? requests[index - 1] : undefined;
  const next = requests[index + 1];
  return {
    request,
    position: requests.length > 1 ? { at: index + 1, of: requests.length } : null,
    previousRequestId: previous === undefined ? undefined : readId(previous),
    nextRequestId: next === undefined ? undefined : readId(next),
  };
};
