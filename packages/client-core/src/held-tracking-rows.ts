/**
 * The rows Tracking shows, which can lag the last read (spec 17 §Tracking,
 * Motion). Like Intake's signals (`held-signals`), a change the user did not
 * make waits while the pointer is on the list column, and applies once the
 * pointer leaves, so no row moves under the pointer. A change the user's own
 * action made applies at once:
 *
 * - Marking a row done takes that row off, and nothing else moves.
 * - A handoff adds the row of its Task, and the rows show the last read
 *   whole, because the new row lands among them.
 */
import type { TrackingRow, TrackingSnapshot } from "./tracking";

/** The rows Tracking shows, and what decides them. */
export interface HeldTrackingRows {
  /** Tracking as last read: its rows in Tracking's order, and the runs they were worked out from. */
  readonly snapshot: TrackingSnapshot;
  /** The rows Tracking shows: the snapshot's rows, less the changes held back. */
  readonly shown: ReadonlyArray<TrackingRow>;
  /** Whether changes the user did not make wait, because the pointer is on the list column. */
  readonly holding: boolean;
  /** The Tasks the user marked done, until the snapshot has no row of them. */
  readonly markedDoneTaskIds: ReadonlySet<string>;
  /** The signals the user handed off, until the snapshot holds the run of the handoff. */
  readonly handoffSignalIds: ReadonlySet<string>;
}

/** Returns the record for rows that open on `snapshot`: nothing held. */
export const startHeldTrackingRows = (snapshot: TrackingSnapshot): HeldTrackingRows => ({
  snapshot,
  shown: snapshot.rows,
  holding: false,
  markedDoneTaskIds: new Set(),
  handoffSignalIds: new Set(),
});

/**
 * Checks whether `snapshot` shows the handoff of the signal `signalId`: a row
 * whose Task has a handoff entry for the signal, and the run that entry names
 * is among the runs of the snapshot. A read of the Tasks can answer before the
 * read of their runs does, so the entry alone does not show the run is there.
 */
const showsHandoff = (snapshot: TrackingSnapshot, signalId: string): boolean =>
  snapshot.rows.some((row) =>
    row.task.provenance.some(
      (entry) =>
        entry.signalId === signalId &&
        entry.runId !== undefined &&
        snapshot.runIds.includes(entry.runId),
    ),
  );

/**
 * Follows a new read of Tracking, `snapshot`. The user's own changes that it
 * shows apply and are forgotten. While holding, every other change waits.
 * Otherwise the rows shown are the snapshot's.
 */
export const followTrackingSnapshot = (
  held: HeldTrackingRows,
  snapshot: TrackingSnapshot,
): HeldTrackingRows => {
  const taskIds = new Set(snapshot.rows.map((row) => row.task.id));
  const markedDone = [...held.markedDoneTaskIds].filter((id) => !taskIds.has(id));
  const shownHandoffs = [...held.handoffSignalIds].filter((signalId) =>
    showsHandoff(snapshot, signalId),
  );
  const shown =
    !held.holding || shownHandoffs.length > 0
      ? snapshot.rows
      : held.shown.filter((row) => !markedDone.includes(row.task.id));
  return {
    ...held,
    snapshot,
    shown,
    markedDoneTaskIds: new Set(
      [...held.markedDoneTaskIds].filter((id) => !markedDone.includes(id)),
    ),
    handoffSignalIds: new Set(
      [...held.handoffSignalIds].filter((id) => !shownHandoffs.includes(id)),
    ),
  };
};

/**
 * Records that the user is marking the Task `taskId` done. Call it when the
 * action starts, before it is sent, because the read that shows the change can
 * come before the action's answer.
 */
export const recordTrackingRowMarkedDone = (
  held: HeldTrackingRows,
  taskId: string,
): HeldTrackingRows => ({
  ...held,
  markedDoneTaskIds: new Set([...held.markedDoneTaskIds, taskId]),
});

/** Forgets that the user is marking `taskId` done, because the action failed. */
export const dropTrackingRowMarkedDone = (
  held: HeldTrackingRows,
  taskId: string,
): HeldTrackingRows => ({
  ...held,
  markedDoneTaskIds: new Set([...held.markedDoneTaskIds].filter((id) => id !== taskId)),
});

/** Records that the user is handing the signal `signalId` off. Call it when the handoff starts. */
export const recordTrackingHandoff = (
  held: HeldTrackingRows,
  signalId: string,
): HeldTrackingRows => ({
  ...held,
  handoffSignalIds: new Set([...held.handoffSignalIds, signalId]),
});

/** Forgets the handoff of `signalId`, because it failed. */
export const dropTrackingHandoff = (
  held: HeldTrackingRows,
  signalId: string,
): HeldTrackingRows => ({
  ...held,
  handoffSignalIds: new Set([...held.handoffSignalIds].filter((id) => id !== signalId)),
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
  return holding ? { ...held, holding } : { ...held, holding, shown: held.snapshot.rows };
};
