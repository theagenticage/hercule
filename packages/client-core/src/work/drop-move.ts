import type { BoardStage, WorkCard } from "@hercule/contract";
import { chooseAfterTaskId, type CardMove } from "./card-move";
import type { ArrangedCell } from "./arrange-cell";
import { buildLanes, chooseLaneId, type WorkProject } from "./lanes";

/**
 * Where a carried card is let go:
 *
 * - `cell`: in an open lane at `stage`, as the card number `index` of the
 *   cards the cell shows (0 is the top), not counting the carried card.
 * - `folded-lane`: on a folded lane, which has no cells to put a slot in. The
 *   stage is the one the pointer is over, or `null` when the pointer is left
 *   of the stages, on the lane's head, which keeps the card's stage.
 */
export type DropPlace =
  | {
      readonly kind: "cell";
      readonly laneId: string;
      readonly stage: BoardStage;
      readonly index: number;
    }
  | { readonly kind: "folded-lane"; readonly laneId: string; readonly stage: BoardStage | null };

/** The part of an arranged lane (a lane with its cells arranged) a drop reads: which cards each of its cells hides behind "13 more". */
export interface DropLane {
  readonly lane: { readonly id: string };
  readonly cells: readonly {
    readonly stage: BoardStage;
    readonly arrangement: Pick<ArrangedCell, "hiddenCards">;
  }[];
}

/** What a drop knows besides the place. */
export interface DropRequest {
  /** Every card of the board in stored order, with the pending moves applied. */
  readonly cards: readonly WorkCard[];
  readonly projects: readonly WorkProject[];
  /** What each lane shows, which says which cards wait behind "13 more". */
  readonly arrangedLanes: readonly DropLane[];
  readonly movingCardId: string;
  readonly place: DropPlace;
  /**
   * For a drop in a cell: the card shown after the slot, or `null` when the
   * slot is after the last card shown. Not used for a folded lane.
   */
  readonly nextShownCardId: string | null;
}

/** Returns the first card a cell hides behind its "13 more" line, or `null` when it hides none. */
const findFirstHiddenCardId = (
  arrangedLanes: readonly DropLane[],
  place: Extract<DropPlace, { kind: "cell" }>,
): string | null =>
  arrangedLanes
    .find((each) => each.lane.id === place.laneId)
    ?.cells.find((cell) => cell.stage === place.stage)?.arrangement.hiddenCards[0]?.id ?? null;

/**
 * Returns the `task.move` that a drop asks for, or `undefined` when the card
 * or the lane is not on the board any more. The caller shows and sends it;
 * a move that changes nothing is dropped there.
 *
 * - The stage is the place's, or the card's own for a drop on a lane's head.
 * - `projectId` is named only when the drop is in another lane than the one
 *   the card stands in, and it is `null` for the "No project" lane. A drop in
 *   the card's own lane never touches its Project.
 * - In a cell, `afterTaskId` is the card the dropped card follows in stored
 *   order (`chooseAfterTaskId`). A slot after the last card shown goes before
 *   the first hidden card, so the card does not jump over cards the user has
 *   not seen.
 * - On a folded lane there is no slot, so `afterTaskId` is absent and the
 *   card goes last in its cell.
 */
export const buildDropMove = (request: DropRequest): CardMove | undefined => {
  const { cards, projects, arrangedLanes, movingCardId, place, nextShownCardId } = request;
  const moving = cards.find((card) => card.id === movingCardId);
  const lane = buildLanes({ cards }, projects).find((each) => each.id === place.laneId);
  if (moving === undefined || lane === undefined) return undefined;

  const stage = place.stage ?? moving.stage;
  const fromLaneId = chooseLaneId(moving, new Set(projects.map((project) => project.id)));
  const move: CardMove = {
    taskId: moving.id,
    stage,
    ...(lane.id === fromLaneId ? {} : { projectId: lane.projectId }),
  };
  if (place.kind === "folded-lane") return move;

  const storedCell = (lane.cells.find((cell) => cell.stage === stage)?.cards ?? []).filter(
    (card) => card.id !== moving.id,
  );
  return {
    ...move,
    afterTaskId: chooseAfterTaskId({
      storedCell,
      nextVisibleCardId: nextShownCardId ?? findFirstHiddenCardId(arrangedLanes, place),
      movingCardFailed: moving.failure !== undefined,
    }),
  };
};
