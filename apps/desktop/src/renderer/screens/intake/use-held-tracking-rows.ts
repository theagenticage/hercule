import { useEffect, useState } from "react";
import { hashKey, useQueryClient } from "@tanstack/react-query";
import {
  dropTrackingHandoff,
  dropTrackingRowMarkedDone,
  followTrackingRead,
  queryKeys,
  recordTrackingHandoff,
  recordTrackingHandoffCommitted,
  recordTrackingRead,
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
 * describes. `listed` is the rows as last built: from the last read of
 * Tracking's Tasks and from what waits on the user, so it also changes when a
 * Request opens or a signal arrives. It keeps its identity until a row can
 * have changed. `holding` is set while the changes the user did not make
 * wait: while the pointer is on the list column.
 *
 * The record follows `listed` on every render. A read of the Tasks that
 * changes no row leaves `listed` as it was, so nothing draws the screen again
 * for it. It can still be the first read that started after the user's own
 * handoff committed, so the hook follows the cache for that: it tells the
 * record about each successful read, and the record asks for a new draw only
 * when that read acknowledges a handoff. The record then follows `listed` in
 * that draw, which holds the rows of the read, so a Task the read adds shows.
 */
export const useHeldTrackingRows = (
  listed: ReadonlyArray<TrackingRow>,
  holding: boolean,
): HeldTrackingRowsState => {
  const queryClient = useQueryClient();
  const readStartedAt = (): number =>
    queryClient.getQueryData<TrackingRead>(queryKeys.tracking())?.readStartedAt ?? 0;
  const [held, setHeld] = useState(() => startHeldTrackingRows(listed, readStartedAt()));
  const next = updateTrackingRowsHolding(
    followTrackingRead(held, listed, readStartedAt()),
    holding,
  );
  if (next !== held) setHeld(next);

  useEffect(() => {
    const trackingHash = hashKey(queryKeys.tracking());
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success") return;
      if (event.query.queryHash !== trackingHash) return;
      const read = event.query.state.data as TrackingRead | undefined;
      if (read === undefined) return;
      setHeld((current) => recordTrackingRead(current, read.readStartedAt));
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
