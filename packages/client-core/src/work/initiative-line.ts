/**
 * The line of an Initiative row: its beads, one for each Task, at the stage
 * the Task is at. A folded row draws only this. The rules are the design's,
 * "Plans":
 *
 * - A bead says what its card would say (`decideCardState`): filled is open,
 *   a ring is landed, a faint ring is blocked, marigold has a question, and
 *   the failed mark has failed.
 * - In a cell the beads come in this order: failed, question, open, blocked,
 *   landed. Beads of one kind keep the board's order.
 * - A Done Task has no card, so it is a ring with no Task at the end of the
 *   Landed cell, one for each (`InitiativeLane.doneRingCount`).
 * - Past ten beads in a cell they are drawn as tally marks. The failed mark
 *   stays first, because it is first in the list.
 */
import type { BoardStage } from "@hercule/contract";
import { decideCardState, type CardState } from "./card-state";
import type { LaneCell } from "./lanes";

/** The most beads a cell draws as beads. A cell with more draws tally marks. */
export const MOST_BEADS_BEFORE_TALLY = 10;

/** One bead of a line. */
export interface InitiativeBead {
  /** The Task the bead stands for, or `null` for a ring of a Done Task, which has no card to open. */
  readonly taskId: string | null;
  readonly kind: CardState;
}

/** The beads of one stage of a line. */
export interface InitiativeLineCell {
  readonly stage: BoardStage;
  readonly beads: readonly InitiativeBead[];
  /** Whether the beads are drawn as tally marks: there are more than `MOST_BEADS_BEFORE_TALLY`. */
  readonly isTally: boolean;
}

/** The line of one Initiative row. */
export interface InitiativeLine {
  /** One cell for each board stage, in stage order. */
  readonly cells: readonly InitiativeLineCell[];
  /**
   * The index in `BOARD_STAGES` of the last stage that has a bead, or `null`
   * for no bead. The line is bright up to there and faint after it.
   */
  readonly reachStageIndex: number | null;
}

const BEAD_ORDER: Readonly<Record<CardState, number>> = {
  failed: 0,
  question: 1,
  open: 2,
  blocked: 3,
  landed: 4,
};

/**
 * Returns the line for the `cells` of a row (its cards at each stage, as the
 * filter leaves them) and `doneRingCount` rings of Done Tasks.
 */
export const buildInitiativeLine = (
  cells: readonly LaneCell[],
  doneRingCount: number,
): InitiativeLine => {
  const lineCells = cells.map(({ stage, cards }): InitiativeLineCell => {
    const beads = cards
      .map((card): InitiativeBead => ({ taskId: card.id, kind: decideCardState(card) }))
      .toSorted((a, b) => BEAD_ORDER[a.kind] - BEAD_ORDER[b.kind]);
    const rings =
      stage === "landed"
        ? Array.from({ length: doneRingCount }, (): InitiativeBead => ({
            taskId: null,
            kind: "landed",
          }))
        : [];
    const all = [...beads, ...rings];
    return { stage, beads: all, isTally: all.length > MOST_BEADS_BEFORE_TALLY };
  });
  const last = lineCells.findLastIndex((cell) => cell.beads.length > 0);
  return { cells: lineCells, reachStageIndex: last < 0 ? null : last };
};
