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
  /** The signals the user handed off, until `listed` shows the handoff. */
  readonly handoffSignalIds: ReadonlySet<string>;
}

/** Returns the record for rows that open on `listed`: nothing held. */
export const startHeldTrackingRows = (listed: ReadonlyArray<TrackingRow>): HeldTrackingRows => ({
  listed,
  shown: listed,
  holding: false,
  markedDoneTaskIds: new Set(),
  handoffSignalIds: new Set(),
});

/**
 * Checks whether `rows` show the handoff of the signal `signalId`: a row that
 * has a handoff of the signal, and the run of that handoff is the row's newest
 * run or its newest live run. A row can already have an older handoff of the
 * signal's Task while the run of the new one is not its newest yet.
 */
const showsHandoff = (rows: ReadonlyArray<TrackingRow>, signalId: string): boolean =>
  rows.some((row) =>
    row.task.handoffs.some(
      (handoff) =>
        handoff.signalId === signalId &&
        (handoff.runId === row.task.latestRun.id || handoff.runId === row.task.latestLiveRun?.id),
    ),
  );

/**
 * Follows a new read of the rows, `listed`. The user's own changes that
 * `listed` shows apply and are forgotten. While holding, every other change
 * waits. Otherwise the rows shown are `listed`.
 */
export const followListedTrackingRows = (
  held: HeldTrackingRows,
  listed: ReadonlyArray<TrackingRow>,
): HeldTrackingRows => {
  const taskIds = new Set(listed.map((row) => row.task.taskId));
  const markedDone = [...held.markedDoneTaskIds].filter((id) => !taskIds.has(id));
  const shownHandoffs = [...held.handoffSignalIds].filter((signalId) =>
    showsHandoff(listed, signalId),
  );
  const shown =
    !held.holding || shownHandoffs.length > 0
      ? listed
      : held.shown.filter((row) => !markedDone.includes(row.task.taskId));
  return {
    ...held,
    listed,
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
  return holding ? { ...held, holding } : { ...held, holding, shown: held.listed };
};
