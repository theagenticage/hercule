/**
 * The rows Tracking shows, which can lag the last read (spec 17 §Tracking,
 * Motion). Like Intake's signals (`held-signals`), a change the user did not
 * make waits while the pointer is on the list column, and applies once the
 * pointer leaves, so no row moves under the pointer. A change the user's own
 * action made applies at once:
 *
 * - Marking a row done takes that row off, and nothing else moves.
 * - Handing a signal off adds the row of its Task, and the rows show the
 *   last read whole, because the new row lands among them.
 */
import type { TrackingRow } from "./tracking";

/** The rows Tracking shows, and what decides them. */
export interface HeldTrackingRows {
  /** Tracking's rows as last read, in Tracking's order. */
  readonly listed: ReadonlyArray<TrackingRow>;
  /** The rows Tracking shows: `listed`, less the changes held back. */
  readonly shown: ReadonlyArray<TrackingRow>;
  /** Whether changes the user did not make wait, because the pointer is on the list column. */
  readonly holding: boolean;
  /** The Tasks the user marked done, until `listed` has no row of them. */
  readonly markedDoneTaskIds: ReadonlySet<string>;
  /** The signals the user handed off, until a row of `listed` has a Task that names one of them. */
  readonly handedOffSignalIds: ReadonlySet<string>;
}

/** Returns the record for rows that open on `listed`: nothing held. */
export const startHeldTrackingRows = (listed: ReadonlyArray<TrackingRow>): HeldTrackingRows => ({
  listed,
  shown: listed,
  holding: false,
  markedDoneTaskIds: new Set(),
  handedOffSignalIds: new Set(),
});

/** Checks whether the Task of `row` has a handoff entry for the signal `signalId`. */
const namesSignal = (row: TrackingRow, signalId: string): boolean =>
  row.task.provenance.some((entry) => entry.signalId === signalId);

/**
 * Follows a new read of the rows, `listed`. The user's own changes that
 * `listed` shows apply and are forgotten. While holding, every other change
 * waits. Otherwise the rows shown are `listed`.
 */
export const followListedTrackingRows = (
  held: HeldTrackingRows,
  listed: ReadonlyArray<TrackingRow>,
): HeldTrackingRows => {
  const listedTaskIds = new Set(listed.map((row) => row.task.id));
  const markedDone = [...held.markedDoneTaskIds].filter((id) => !listedTaskIds.has(id));
  const handedOff = [...held.handedOffSignalIds].filter((signalId) =>
    listed.some((row) => namesSignal(row, signalId)),
  );
  const shown =
    !held.holding || handedOff.length > 0
      ? listed
      : held.shown.filter((row) => !markedDone.includes(row.task.id));
  return {
    ...held,
    listed,
    shown,
    markedDoneTaskIds: new Set(
      [...held.markedDoneTaskIds].filter((id) => !markedDone.includes(id)),
    ),
    handedOffSignalIds: new Set(
      [...held.handedOffSignalIds].filter((id) => !handedOff.includes(id)),
    ),
  };
};

/**
 * Records that the user is marking the Task `taskId` done. Call it when the
 * action starts, before it is sent, because the read that shows the change can
 * come before the action's answer.
 */
export const recordMarkedDone = (held: HeldTrackingRows, taskId: string): HeldTrackingRows => ({
  ...held,
  markedDoneTaskIds: new Set([...held.markedDoneTaskIds, taskId]),
});

/** Forgets that the user is marking `taskId` done, because the action failed. */
export const dropMarkedDone = (held: HeldTrackingRows, taskId: string): HeldTrackingRows => ({
  ...held,
  markedDoneTaskIds: new Set([...held.markedDoneTaskIds].filter((id) => id !== taskId)),
});

/** Records that the user is handing the signal `signalId` off. Call it when the action starts. */
export const recordHandedOff = (held: HeldTrackingRows, signalId: string): HeldTrackingRows => ({
  ...held,
  handedOffSignalIds: new Set([...held.handedOffSignalIds, signalId]),
});

/** Forgets that the user is handing `signalId` off, because the action failed. */
export const dropHandedOff = (held: HeldTrackingRows, signalId: string): HeldTrackingRows => ({
  ...held,
  handedOffSignalIds: new Set([...held.handedOffSignalIds].filter((id) => id !== signalId)),
});

/**
 * Starts or stops holding back the changes the user did not make. Stopping
 * shows the last read in one step, so its changes move as one block.
 */
export const updateTrackingRowsHolding = (
  held: HeldTrackingRows,
  holding: boolean,
): HeldTrackingRows => {
  if (held.holding === holding) return held;
  return holding ? { ...held, holding } : { ...held, holding, shown: held.listed };
};
