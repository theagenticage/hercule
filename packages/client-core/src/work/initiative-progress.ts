/**
 * How far an Initiative has come, in its own words. An Initiative is the
 * user's own, so its Tasks are the whole count, unlike an outside project,
 * whose progress is only what its source reports.
 */
import type { WorkBoard } from "@hercule/contract";

/** The Tasks of an Initiative: how many are finished, and how many there are. */
export interface InitiativeProgress {
  /** Tasks at Landed or Done. */
  readonly landed: number;
  /** Tasks on the Initiative that are not Dropped. */
  readonly total: number;
}

/**
 * Returns the progress of the Initiative `initiativeId`. A Task at Landed
 * counts as landed, and so does a Done Task, which has no card and is counted
 * by `board.initiativeDoneCounts`. A Dropped Task is on neither list, so it
 * leaves the total.
 *
 * Pass the whole board, not what a filter leaves, so that the count says the
 * same whatever the user is looking for. Pass a board with the user's pending
 * changes applied (`buildLogicalBoard`), so that a Task the user just marked
 * Done keeps counting while the controller has not answered.
 */
export const computeInitiativeProgress = (
  board: Pick<WorkBoard, "cards" | "initiativeDoneCounts">,
  initiativeId: string,
): InitiativeProgress => {
  const done = board.initiativeDoneCounts[initiativeId] ?? 0;
  const cards = board.cards.filter((card) => card.initiativeId === initiativeId);
  return {
    landed: cards.filter((card) => card.stage === "landed").length + done,
    total: cards.length + done,
  };
};

/**
 * Returns the small facts under an Initiative's name: the name of its Project
 * and its progress, joined by a dot, such as "Platform · 2 of 8 landed". Each
 * part is left out when it is not known: `projectName` is absent for a row
 * that sits in its Project's lane, and the progress is left out for an
 * Initiative with no Task. Returns `null` when nothing is left.
 */
export const describeInitiativeFacts = (
  progress: InitiativeProgress,
  projectName: string | undefined,
): string | null => {
  const words = [
    projectName,
    progress.total === 0
      ? undefined
      : `${String(progress.landed)} of ${String(progress.total)} landed`,
  ].filter((part) => part !== undefined);
  return words.length === 0 ? null : words.join(" · ");
};
