import type { BoardStage, WorkBoard, WorkCard } from "@hercule/contract";
import type { ArrangedLane } from "./arrange-lanes";
import { chooseAfterTaskId, settleDropMove, type CardMove, type DropMove } from "./card-move";
import type { WorkProject } from "./lanes";

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
  /**
   * The ids of the other cards carried with the moving card. They leave their
   * cells with it, so the card to follow is never one of them. Absent for a
   * card carried alone.
   */
  readonly followerIds?: readonly string[];
}

/**
 * Returns the drop: the `task.move` it asks for, and the Project of the lane
 * it is let go on. The caller checks the drop with `settleDropMove`, then
 * shows and sends the move; a move that changes nothing is dropped there.
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
 * - On a lane for an outside place the drop changes the stage only: no
 *   `projectId` and no `afterTaskId`, because the lane belongs to the source
 *   and a cell is still a Project and a stage. The card goes last in its
 *   stored cell, and the lane shows it by that order.
 * - On a folded lane there is no slot, so `afterTaskId` is absent and the
 *   card goes last in its cell.
 */
export const buildDropMove = (request: DropRequest): DropMove => {
  const { movingCard, lane, beforeCardId } = request;
  const stage = request.stage ?? movingCard.stage;
  if (lane.lane.outside !== undefined) {
    return { move: { taskId: movingCard.id, stage }, targetProjectId: null };
  }
  const isOwnLane = lane.lane.cells.some((cell) =>
    cell.cards.some((card) => card.id === movingCard.id),
  );
  const move: CardMove = {
    taskId: movingCard.id,
    stage,
    ...(isOwnLane ? {} : { projectId: lane.lane.projectId }),
  };
  const targetProjectId = lane.lane.projectId;
  if (lane.isFolded) return { move, targetProjectId };

  const leavingIds = new Set([movingCard.id, ...(request.followerIds ?? [])]);
  const storedCell = (lane.lane.cells.find((cell) => cell.stage === stage)?.cards ?? []).filter(
    (card) => !leavingIds.has(card.id),
  );
  const firstHiddenCardId =
    lane.cells.find((cell) => cell.stage === stage)?.arrangement.hiddenCards[0]?.id ?? null;
  const afterTaskId = chooseAfterTaskId({
    storedCell,
    nextVisibleCardId: beforeCardId ?? firstHiddenCardId,
    movingCardFailed: movingCard.failure !== undefined,
  });
  return { move: { ...move, afterTaskId }, targetProjectId };
};

/**
 * Returns the moves of the cards carried along with the lead card of a drop,
 * in the order given. Each card lands right after the one before it, the
 * first right after the lead card (`leadMove`), so they keep their relative
 * order. On a folded lane the lead card has no card to follow, and each
 * follower goes last in the cell in turn, which gives the same order.
 *
 * A follower names a Project (`targetProjectId`) only when it stands in
 * another one, as the lead card's move does.
 */
export const buildFollowerMoves = (
  { move: leadMove, targetProjectId }: DropMove,
  followers: readonly WorkCard[],
): readonly CardMove[] => {
  let previousId = leadMove.taskId;
  return followers.map((card) => {
    const move: CardMove = {
      taskId: card.id,
      ...(leadMove.stage === undefined ? {} : { stage: leadMove.stage }),
      ...((card.projectId ?? null) === targetProjectId ? {} : { projectId: targetProjectId }),
      ...(leadMove.afterTaskId === undefined ? {} : { afterTaskId: previousId }),
    };
    previousId = card.id;
    return move;
  });
};

/**
 * What to do with a drop of several cards: send `moves`, the lead card's first
 * and then one for each follower still on the board, with `note` added to the
 * undo line when there is one, or send nothing and say why in `reason`.
 */
export type SettledGroupDrop =
  | { readonly kind: "send"; readonly moves: readonly CardMove[]; readonly note?: string }
  | { readonly kind: "refuse"; readonly reason: string };

/** Returns the note for an undo line when `count` followers left the board during the carry. */
export const describeFollowersGone = (count: number): string =>
  count === 1
    ? "1 of the selected Tasks had left the board, so it was not moved."
    : `${String(count)} of the selected Tasks had left the board, so they were not moved.`;

/**
 * Returns what to do with `drop` of the lead card `leadCardId`, which carries
 * `followers` along, over `board` as it is now. The lead card's move is
 * settled as for a single card (`settleDropMove`); when it is refused, so is
 * the whole drop. A follower that has left the board is left out, and the note
 * says how many. The others follow the lead card in the order given.
 */
export const settleGroupDrop = (
  board: Pick<WorkBoard, "cards">,
  projects: readonly WorkProject[],
  drop: DropMove,
  followers: readonly WorkCard[],
): SettledGroupDrop => {
  const settled = settleDropMove(board, projects, drop);
  if (settled.kind === "refuse") return settled;
  const present = followers.flatMap((follower) => {
    const current = board.cards.find((card) => card.id === follower.id);
    return current === undefined ? [] : [current];
  });
  const gone = followers.length - present.length;
  const notes = [settled.note, gone === 0 ? undefined : describeFollowersGone(gone)].filter(
    (each) => each !== undefined,
  );
  return {
    kind: "send",
    moves: [
      settled.move,
      ...buildFollowerMoves({ move: settled.move, targetProjectId: drop.targetProjectId }, present),
    ],
    ...(notes.length === 0 ? {} : { note: notes.join(" ") }),
  };
};
