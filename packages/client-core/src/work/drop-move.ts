import type { BoardStage, WorkCard } from "@hercule/contract";
import type { ArrangedLane } from "./arrange-lanes";
import { chooseAfterTaskId, type CardMove } from "./card-move";

/**
 * Where a carried card is let go:
 *
 * - `cell`: in an open lane at `stage`, before the card `beforeCardId` of the
 *   cards the cell shows, not counting the carried card, or last among them
 *   when it is `null`.
 * - `folded-lane`: on a folded lane, which has no cells to put a slot in. The
 *   stage is the one the pointer is over, or `null` when the pointer is left
 *   of the stages, on the lane's head, which keeps the card's stage.
 */
export type DropPlace =
  | {
      readonly kind: "cell";
      readonly laneId: string;
      readonly stage: BoardStage;
      readonly beforeCardId: string | null;
    }
  | { readonly kind: "folded-lane"; readonly laneId: string; readonly stage: BoardStage | null };

/** What a drop knows: the card in the hand, and the lane and stage it is let go on. */
export interface DropRequest {
  readonly movingCard: WorkCard;
  /** The lane the card is let go on, as the board draws it. */
  readonly lane: ArrangedLane;
  /** The stage the card is let go on, or `null` for the lane's head, which keeps the card's stage. */
  readonly stage: BoardStage | null;
  /**
   * For a drop in a cell: the card shown after the slot, or `null` when the
   * slot is after the last card shown. Not used for a folded lane.
   */
  readonly beforeCardId: string | null;
}

/**
 * Returns the `task.move` that a drop asks for. The caller shows and sends
 * it; a move that changes nothing is dropped there.
 *
 * - The stage is the request's, or the card's own for a drop on a lane's head.
 * - `projectId` is named only when the drop is in another lane than the one
 *   the card stands in, and it is `null` for the "No project" lane. A drop in
 *   the card's own lane never touches its Project.
 * - In a cell, `afterTaskId` is the card the dropped card follows in stored
 *   order (`chooseAfterTaskId`), which is not the order on screen: a failed
 *   card floats to the top of its cell. A slot after the last card shown goes
 *   before the first hidden card, so the card does not jump over cards the
 *   user has not seen.
 * - On a folded lane there is no slot, so `afterTaskId` is absent and the
 *   card goes last in its cell.
 */
export const buildDropMove = (request: DropRequest): CardMove => {
  const { movingCard, lane, beforeCardId } = request;
  const stage = request.stage ?? movingCard.stage;
  const isOwnLane = lane.lane.cells.some((cell) =>
    cell.cards.some((card) => card.id === movingCard.id),
  );
  const move: CardMove = {
    taskId: movingCard.id,
    stage,
    ...(isOwnLane ? {} : { projectId: lane.lane.projectId }),
  };
  if (lane.isFolded) return move;

  const storedCell = (lane.lane.cells.find((cell) => cell.stage === stage)?.cards ?? []).filter(
    (card) => card.id !== movingCard.id,
  );
  const firstHiddenCardId =
    lane.cells.find((cell) => cell.stage === stage)?.arrangement.hiddenCards[0]?.id ?? null;
  return {
    ...move,
    afterTaskId: chooseAfterTaskId({
      storedCell,
      nextVisibleCardId: beforeCardId ?? firstHiddenCardId,
      movingCardFailed: movingCard.failure !== undefined,
    }),
  };
};
