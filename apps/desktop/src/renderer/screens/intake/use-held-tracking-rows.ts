import { useEffect, useState } from "react";
import { hashKey, useQueryClient } from "@tanstack/react-query";
import {
  dropTrackingHandoff,
  dropTrackingRowMarkedDone,
  followTrackingRead,
  queryKeys,
  recordTrackingHandoff,
  recordTrackingHandoffCommitted,
  recordTrackingRowMarkedDone,
  startHeldTrackingRows,
  updateTrackingRowsHolding,
  type TrackingRead,
  type TrackingRow,
} from "@hercule/client-core";

/** The rows Tracking shows, and the screen's ways to mark the user's own changes. */
export interface HeldTrackingRowsState {
  /** The rows Tracking shows, in Tracking's order: the last read, less the changes held back. */
  readonly shown: ReadonlyArray<TrackingRow>;
  /** Records that the user is marking the Task `taskId` done. Call it when the action starts. */
  readonly registerMarkedDone: (taskId: string) => void;
  /** Forgets that the user is marking `taskId` done, because the action failed. */
  readonly forgetMarkedDone: (taskId: string) => void;
  /** Records that the user is handing the signal `signalId` off. Call it when the handoff starts. */
  readonly registerHandoff: (signalId: string) => void;
  /** Forgets the handoff of `signalId`, because it failed. */
  readonly forgetHandoff: (signalId: string) => void;
  /**
   * Records that the handoff of `signalId` committed, and reads Tracking again:
   * that read starts after the commit, so it shows the handoff. Call it when the
   * controller answers the handoff.
   */
  readonly confirmHandoff: (signalId: string) => void;
}

/**
 * Returns the rows Tracking shows, as `held-tracking-rows` in client-core
 * describes. `listed` is the last read of Tracking's rows, and keeps its identity
 * until the read changes; the time that read started is the one in the cached
 * `TrackingRead`. The hook also follows the cache for a read that changes no row,
 * which can still be the first that started after the user's handoff, without
 * drawing the screen again for it. `holding` is set while the changes the user did not
 * make wait: while the pointer is on the list column.
 */
export const useHeldTrackingRows = (
  listed: ReadonlyArray<TrackingRow>,
  holding: boolean,
): HeldTrackingRowsState => {
  const queryClient = useQueryClient();
  const readStartedAt = (): number =>
    queryClient.getQueryData<TrackingRead>(queryKeys.tracking())?.readStartedAt ?? 0;
  const [held, setHeld] = useState(() => startHeldTrackingRows(listed, readStartedAt()));
  let next = held;
  if (next.listed !== listed) next = followTrackingRead(next, listed, readStartedAt());
  next = updateTrackingRowsHolding(next, holding);
  if (next !== held) setHeld(next);

  // A read that changes no row leaves the rows array as it was, so the screen is not told of it.
  // The record follows the cache itself, and changes only when the read acknowledges a handoff.
  useEffect(() => {
    const trackingHash = hashKey(queryKeys.tracking());
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success") return;
      if (event.query.queryHash !== trackingHash) return;
      const read = event.query.state.data as TrackingRead | undefined;
      if (read === undefined) return;
      setHeld((current) => followTrackingRead(current, read.rows, read.readStartedAt));
    });
  }, [queryClient]);
  return {
    shown: next.shown,
    registerMarkedDone: (taskId) => {
      setHeld((current) => recordTrackingRowMarkedDone(current, taskId));
    },
    forgetMarkedDone: (taskId) => {
      setHeld((current) => dropTrackingRowMarkedDone(current, taskId));
    },
    registerHandoff: (signalId) => {
      setHeld((current) => recordTrackingHandoff(current, signalId));
    },
    forgetHandoff: (signalId) => {
      setHeld((current) => dropTrackingHandoff(current, signalId));
    },
    confirmHandoff: (signalId) => {
      // The time is taken here, not in the updater: React may run the updater later, after the
      // read below has started, and that read could then not tell it started after the commit.
      const committedAt = performance.now();
      setHeld((current) => recordTrackingHandoffCommitted(current, signalId, committedAt));
      // A read already under way may have started before the commit, so it is
      // replaced by one that starts now.
      void queryClient.refetchQueries(
        { queryKey: queryKeys.tracking(), exact: true },
        { cancelRefetch: true },
      );
    },
  };
};
