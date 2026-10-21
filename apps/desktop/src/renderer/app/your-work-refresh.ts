/**
 * Keeps Your work current with the To do list.
 *
 * Your work is read for the thread refs of the To do signals, and records
 * them (`YourWorkRead`). To do changes on its own: a push reads it again, and
 * a move of signals writes to its cached list before the controller answers.
 * When the refs of To do are no longer the ones Your work was read for, Your
 * work is read again. A read that fails is read again too, if To do moved on
 * to other refs while it ran.
 */
import { hashKey, type QueryClient } from "@tanstack/react-query";
import {
  invalidateWithoutCancelling,
  isYourWorkReadOutdated,
  listYourWorkRefs,
  queryKeys,
  type YourWorkRead,
} from "@hercule/client-core";
import type { Signal } from "@hercule/contract";
import { TO_DO_SIGNALS_KEY } from "./queries";

/**
 * Reads Your work again when its refs differ from the refs of the cached To do
 * list. Does nothing in these cases:
 *
 * - Your work has no answer yet, or To do has none. A read that has not
 *   finished is made for the signals it finds, and the check runs again when
 *   it settles.
 * - Your work is being read. The check runs again when that read settles, so
 *   a read is never started on top of one that is running, and a finished
 *   read is never thrown away.
 * - The refs are the same.
 */
const readYourWorkIfOutdated = (queryClient: QueryClient): void => {
  const yourWork = queryClient.getQueryState<YourWorkRead>(queryKeys.yourWork());
  const signals = queryClient.getQueryData<ReadonlyArray<Signal>>(TO_DO_SIGNALS_KEY);
  if (yourWork?.data === undefined || yourWork.fetchStatus !== "idle" || signals === undefined) {
    return;
  }
  if (isYourWorkReadOutdated(yourWork.data, signals)) {
    invalidateWithoutCancelling(queryClient, queryKeys.yourWork());
  }
};

/**
 * Starts reading Your work again whenever the thread refs of the To do signals
 * stop matching the refs its last read was made for, and returns a function
 * that stops this. Call it once, where the shell keeps its reads current.
 *
 * The check runs at four moments:
 *
 * - When something stores a list in To do's cache: a read of To do, or a write
 *   such as an optimistic move or its undo.
 * - When a read of Your work succeeds. The refs may have changed while it was
 *   running, and that is the only time they can be compared with the refs the
 *   read was made for.
 * - When a read of Your work fails, once Query has given up on it. A change
 *   that came while it ran found it busy, and nothing else would start a read
 *   for it. The failed read stores no refs, so the refs it started with are
 *   remembered. If To do still has those, the read is not repeated: it would
 *   fail the same way, and the next write to To do tries again.
 * - Once when this starts, for a change that came before anyone listened.
 *
 * Under a steady stream of changes, each read of Your work still finishes and
 * is stored, and then one more read starts for the newest refs. A change that
 * keeps the refs costs no request.
 */
export const startYourWorkRefresh = (queryClient: QueryClient): (() => void) => {
  const toDoHash = hashKey(TO_DO_SIGNALS_KEY);
  const yourWorkHash = hashKey(queryKeys.yourWork());
  // The refs To do had when the latest read of Your work started.
  let startedWith: Pick<YourWorkRead, "refs"> | undefined;
  const stop = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated") return;
    const { queryHash } = event.query;
    if (queryHash === yourWorkHash && event.action.type === "fetch") {
      const signals = queryClient.getQueryData<ReadonlyArray<Signal>>(TO_DO_SIGNALS_KEY);
      startedWith = signals === undefined ? undefined : { refs: listYourWorkRefs(signals) };
    } else if (queryHash === yourWorkHash && event.action.type === "error") {
      const signals = queryClient.getQueryData<ReadonlyArray<Signal>>(TO_DO_SIGNALS_KEY);
      if (
        signals !== undefined &&
        (startedWith === undefined || isYourWorkReadOutdated(startedWith, signals))
      ) {
        invalidateWithoutCancelling(queryClient, queryKeys.yourWork());
      }
    } else if (
      event.action.type === "success" &&
      (queryHash === toDoHash || queryHash === yourWorkHash)
    ) {
      // A write to the cache is a `success` action too, marked `manual`.
      readYourWorkIfOutdated(queryClient);
    }
  });
  readYourWorkIfOutdated(queryClient);
  return stop;
};
