import {
  buildLanes,
  chooseAfterTaskId,
  chooseLaneId,
  type CardMove,
  type WorkProject,
} from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";
import type { ArrangedLane } from "./arrange-lanes";
import type { DropPlace } from "./board-drag-geometry";

/** What a drop knows besides the place. */
export interface DropRequest {
  /** Every card of the board in stored order, with the pending moves applied. */
  readonly cards: readonly WorkCard[];
  readonly projects: readonly WorkProject[];
  /** What each lane shows, which says which cards wait behind "13 more". */
  readonly arranged: readonly ArrangedLane[];
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
  arranged: readonly ArrangedLane[],
  place: Extract<DropPlace, { kind: "cell" }>,
): string | null =>
  arranged
    .find((each) => each.lane.id === place.laneId)
    ?.cells.find((cell) => cell.stage === place.stage)?.arranged.hiddenCards[0]?.id ?? null;

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
  const { cards, projects, arranged, movingCardId, place, nextShownCardId } = request;
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
      nextVisibleCardId: nextShownCardId ?? findFirstHiddenCardId(arranged, place),
      movingCardFailed: moving.failure !== undefined,
    }),
  };
};
