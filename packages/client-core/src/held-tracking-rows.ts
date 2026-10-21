/**
 * The rows Tracking shows, which can lag the last read (spec 17 §Tracking,
 * Motion). Like Intake's signals (`held-signals`), a change the user did not
 * make waits while the pointer is on the list column, and applies once the
 * pointer leaves, so no row moves under the pointer. A change the user's own
 * action made applies at once:
 *
 * - Marking a row done takes that row off, and nothing else moves.
 * - A handoff adds the row of its Task, and the rows show the last read
 *   whole, because the new row lands among them. A read shows the handoff
 *   when it started after the handoff committed, not when it lists the
 *   handoff: a read lists only a Task's newest handoffs, so later handoffs can
 *   push this one out of it.
 */
import type { TrackingRow } from "./tracking";

/** The rows Tracking shows, and what decides them. */
export interface HeldTrackingRows {
  /**
   * Tracking's rows as last built, in Tracking's order. A row changes when the
   * Tasks are read again, and also when a Request or a signal that a row waits
   * on comes or goes, because Needs you is built from them.
   */
  readonly listed: ReadonlyArray<TrackingRow>;
  /** The rows Tracking shows: `listed`, less the changes held back. */
  readonly shown: ReadonlyArray<TrackingRow>;
  /** Whether changes the user did not make wait, because the pointer is on the list column. */
  readonly holding: boolean;
  /** The Tasks the user marked done, until `listed` has no row of them. */
  readonly markedDoneTaskIds: ReadonlySet<string>;
  /**
   * When the newest read of Tracking's Tasks that the record has followed
   * started, on the clock `TrackingRead` names. The Tasks in `listed` are as
   * the controller held them from that moment on.
   */
  readonly readStartedAt: number;
  /**
   * The signals the user is handing off, each with when its handoff
   * committed, or `null` while it is still being sent. A handoff stays until a
   * read that started after it committed gives `listed`, or the holding stops.
   */
  readonly handoffs: ReadonlyMap<string, number | null>;
}

/** Returns the record for rows that open on `listed`: nothing held. */
export const startHeldTrackingRows = (
  listed: ReadonlyArray<TrackingRow>,
  readStartedAt = 0,
): HeldTrackingRows => ({
  listed,
  shown: listed,
  holding: false,
  markedDoneTaskIds: new Set(),
  readStartedAt,
  handoffs: new Map(),
});

/**
 * Follows a new read of the rows, `listed`, which started at `readStartedAt`.
 * The user's own changes that `listed` shows apply and are forgotten: a row
 * marked done that it lacks, and a handoff that committed before the read
 * started. While holding, every other change waits. Otherwise the rows shown
 * are `listed`.
 */
export const followListedTrackingRows = (
  held: HeldTrackingRows,
  listed: ReadonlyArray<TrackingRow>,
  readStartedAt: number,
): HeldTrackingRows => {
  const taskIds = new Set(listed.map((row) => row.task.taskId));
  const markedDone = [...held.markedDoneTaskIds].filter((id) => !taskIds.has(id));
  const shownHandoffs = [...held.handoffs]
    .filter(([, committedAt]) => committedAt !== null && committedAt <= readStartedAt)
    .map(([signalId]) => signalId);
  const shown =
    !held.holding || shownHandoffs.length > 0
      ? listed
      : held.shown.filter((row) => !markedDone.includes(row.task.taskId));
  return {
    ...held,
    listed,
    shown,
    readStartedAt,
    markedDoneTaskIds: new Set(
      [...held.markedDoneTaskIds].filter((id) => !markedDone.includes(id)),
    ),
    handoffs: new Map([...held.handoffs].filter(([id]) => !shownHandoffs.includes(id))),
  };
};

/**
 * Follows the rows, `rows`, as last built from the newest read of Tracking's
 * Tasks, which started at `readStartedAt`. It is `followListedTrackingRows`,
 * except that it leaves `held` as it is, the very same record, when `rows` are
 * the rows already listed and the read acknowledges no handoff. A read that
 * changed none of the Tasks, which the query then shares with the read before
 * it, can still be the first that started after a handoff committed.
 */
export const followTrackingRead = (
  held: HeldTrackingRows,
  rows: ReadonlyArray<TrackingRow>,
  readStartedAt: number,
): HeldTrackingRows =>
  rows === held.listed && !isHandoffCommittedBefore(held, readStartedAt)
    ? held
    : followListedTrackingRows(held, rows, readStartedAt);

/** Checks whether a handoff of `held` committed before a read that started at `readStartedAt`. */
const isHandoffCommittedBefore = (held: HeldTrackingRows, readStartedAt: number): boolean =>
  [...held.handoffs.values()].some(
    (committedAt) => committedAt !== null && committedAt <= readStartedAt,
  );

/**
 * Records that a read of Tracking's Tasks, which started at `readStartedAt`,
 * has succeeded. Returns `held` itself unless that read is the first that
 * started after a handoff committed. Then it returns a new record, so the
 * screen draws again and follows the rows (`followTrackingRead`) with the
 * rows built from the read.
 *
 * It does not follow the rows itself, because it does not have them: they are
 * built from the Tasks and from what waits on the user. If it applied the
 * handoff to the rows listed so far, a read that also changed the Tasks, such
 * as the one that adds the handed-off Task's row, would acknowledge the
 * handoff before that row was listed, and a record holding back changes would
 * never show it.
 */
export const recordTrackingRead = (
  held: HeldTrackingRows,
  readStartedAt: number,
): HeldTrackingRows =>
  isHandoffCommittedBefore(held, readStartedAt) ? { ...held, readStartedAt } : held;

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
  handoffs: new Map([...held.handoffs, [signalId, null]]),
});

/**
 * Records that the handoff of `signalId` committed at `committedAt`, on the
 * clock `TrackingRead` names: the controller answered the handoff. Does
 * nothing when the handoff is no longer recorded, such as after the holding
 * stopped.
 */
export const recordTrackingHandoffCommitted = (
  held: HeldTrackingRows,
  signalId: string,
  committedAt: number,
): HeldTrackingRows =>
  held.handoffs.has(signalId)
    ? { ...held, handoffs: new Map([...held.handoffs, [signalId, committedAt]]) }
    : held;

/** Forgets the handoff of `signalId`, because it failed. */
export const dropTrackingHandoff = (
  held: HeldTrackingRows,
  signalId: string,
): HeldTrackingRows => ({
  ...held,
  handoffs: new Map([...held.handoffs].filter(([id]) => id !== signalId)),
});

/**
 * Starts or stops holding back the changes the user did not make. Stopping
 * shows the last read in one step, so its changes move as one block, and
 * forgets the handoffs still waiting for a read: nothing is held back for them
 * any more.
 */
export const updateTrackingRowsHolding = (
  held: HeldTrackingRows,
  holding: boolean,
): HeldTrackingRows => {
  if (held.holding === holding) return held;
  return holding
    ? { ...held, holding }
    : { ...held, holding, shown: held.listed, handoffs: new Map() };
};
