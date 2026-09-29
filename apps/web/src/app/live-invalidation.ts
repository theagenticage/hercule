/**
 * Keeps a screen's data current through the live connection.
 *
 * Records change while a screen is open - an agent triages a task, a machine
 * goes quiet - so a screen should show the controller's current state, not the
 * state when the screen opened. Each push lists the query keys that changed,
 * and the cache fetches them again. The screen itself never deals with the
 * socket.
 *
 * A push never cancels a read that is already running. By default,
 * `invalidateQueries` cancels a query's running read and starts a new one. A
 * burst of pushes, such as a thread that streams its output, would then
 * cancel read after read, and the list could go without an answer for as long
 * as the burst lasts. The desktop app keeps its lists current the same way
 * (`apps/desktop/src/renderer/app/live-invalidation.ts`).
 */
import { useEffect } from "react";
import { CancelledError, type Query, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { Live } from "@hercule/client-core";
import type { MutableLiveTopic } from "@hercule/contract";

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

/** Invalidates one query for a push, as `invalidateWithoutCancelling` describes. */
const readAfterPush = (queryClient: QueryClient, query: Query): void => {
  const watched = watchedReads.get(query);
  if (watched !== undefined) {
    watched.pushedAfterStart = true;
    return;
  }
  const wasReading = query.state.fetchStatus !== "idle";
  // Starts a read, or joins the running one. An inactive query is only
  // marked stale, and is read when a screen uses it again.
  void queryClient.invalidateQueries(
    { queryKey: query.queryKey, exact: true },
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

/** Subscribes to one topic while the calling component is mounted, and invalidates the query keys each push lists. */
export const useLiveInvalidation = (
  live: Live,
  queryClient: QueryClient,
  topic: MutableLiveTopic,
): void => {
  useEffect(
    () =>
      live.subscribe(topic, (keys) => {
        for (const queryKey of keys) invalidateWithoutCancelling(queryClient, queryKey);
      }),
    [live, queryClient, topic],
  );
};
