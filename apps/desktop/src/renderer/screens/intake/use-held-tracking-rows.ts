import { useState } from "react";
import {
  dropTrackingHandoff,
  dropTrackingRowMarkedDone,
  followListedTrackingRows,
  recordTrackingHandoff,
  recordTrackingRowMarkedDone,
  startHeldTrackingRows,
  updateTrackingRowsHolding,
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
}

/**
 * Returns the rows Tracking shows, as `held-tracking-rows` in client-core
 * describes. `listed` is the last read of Tracking's rows, and keeps its identity
 * until the read changes. `holding` is set while the changes the user did not
 * make wait: while the pointer is on the list column.
 */
export const useHeldTrackingRows = (
  listed: ReadonlyArray<TrackingRow>,
  holding: boolean,
): HeldTrackingRowsState => {
  const [held, setHeld] = useState(() => startHeldTrackingRows(listed));
  let next = held;
  if (next.listed !== listed) next = followListedTrackingRows(next, listed);
  next = updateTrackingRowsHolding(next, holding);
  if (next !== held) setHeld(next);
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
  };
};
