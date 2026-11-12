/**
 * Invalidates a query when the live connection reports that its data changed,
 * without cancelling a read that is already running.
 *
 * By default, `invalidateQueries` cancels a query's running read and starts a
 * new one. A burst of pushes, such as a thread that streams its output, would
 * then cancel read after read, and the list could go without an answer for as
 * long as the burst lasts. The web app and the desktop app both keep their
 * lists current with this function.
 */
import { CancelledError, type Query, type QueryClient, type QueryKey } from "@tanstack/query-core";

/**
 * The queries whose running read is being watched, each with whether a push
 * arrived after that read started. Such a read may have been answered before
 * the change the push reports.
 */
const watchedReads = new WeakMap<Query, { pushedAfterStart: boolean }>();

/**
 * Invalidates every query under `queryKey`, and makes sure each active one
 * ends on a read that started after this push and was not cancelled:
 *
 * - A query that is not reading starts a read.
 * - A query that is reading keeps its read, and reads again once that read
 *   settles, whether it succeeded or failed.
 * - A read that something else cancels, such as "load the next page" of an
 *   infinite query, is followed by one more read. The read that replaced it
 *   may fetch only part of the data.
 *
 * However many pushes arrive, a query has at most one read running and one
 * more waiting. Returns at once; never fails.
 */
export const invalidateWithoutCancelling = (queryClient: QueryClient, queryKey: QueryKey): void => {
  for (const query of queryClient.getQueryCache().findAll({ queryKey })) {
    readAfterPush(queryClient, query);
  }
};

/** The pushes of one key that wait for a shared read: its timer, per client. */
const waitingPushes = new WeakMap<QueryClient, Map<string, ReturnType<typeof setTimeout>>>();

/**
 * Invalidates the queries under `queryKey` like `invalidateWithoutCancelling`,
 * but `windowMs` later, and once for every push of that key that arrives in
 * the meantime. One change often causes several pushes in a row (a signal's
 * push, then its entity's), and a large read such as the Inbox's page would
 * otherwise be read once for each. The window starts at the first push and
 * does not move, so a long burst still reads every `windowMs`. Returns at once.
 */
export const invalidateWithoutCancellingSoon = (
  queryClient: QueryClient,
  queryKey: QueryKey,
  windowMs: number,
): void => {
  let timers = waitingPushes.get(queryClient);
  if (timers === undefined) {
    timers = new Map();
    waitingPushes.set(queryClient, timers);
  }
  const id = JSON.stringify(queryKey);
  if (timers.has(id)) return;
  const waiting = timers;
  waiting.set(
    id,
    setTimeout(() => {
      waiting.delete(id);
      invalidateWithoutCancelling(queryClient, queryKey);
    }, windowMs),
  );
};

/** Invalidates one query for a push, as `invalidateWithoutCancelling` describes. */
const readAfterPush = (queryClient: QueryClient, query: Query): void => {
  const watched = watchedReads.get(query);
  if (watched !== undefined) {
    watched.pushedAfterStart = true;
    return;
  }
  const wasReading = query.state.fetchStatus !== "idle";
  // Starts a read, or joins the running one. An inactive query is only
  // marked stale, and is read when a screen uses it again. The filter
  // compares the query itself rather than its key: an exact key match hashes
  // the key of every query in the cache, once for each query a push reads.
  void queryClient.invalidateQueries(
    { predicate: (candidate) => candidate === query },
    { cancelRefetch: false },
  );
  const read = query.promise;
  if (query.state.fetchStatus === "idle" || read === undefined) return;
  const state = { pushedAfterStart: wasReading };
  watchedReads.set(query, state);
  const settle = (cancelled: boolean): void => {
    watchedReads.delete(query);
    if (cancelled || state.pushedAfterStart) readAfterPush(queryClient, query);
  };
  // The query awaits this same promise inside its own read, and it started
  // awaiting before this callback was added. So by the time the callback
  // runs, the query has stored the answer and is no longer reading. A
  // cancelled read is the exception: the read that cancelled it is already
  // running, so the query is invalidated once more after that one.
  read.then(
    () => settle(false),
    (error: unknown) => settle(error instanceof CancelledError),
  );
};
