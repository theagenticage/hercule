import type { BoardStage, WorkBoard, WorkCard } from "@hercule/contract";
import type { ArrangedLane } from "./arrange-lanes";
import { chooseAfterTaskId, settleDropMove, type CardMove, type DropMove } from "./card-move";
import { NO_INITIATIVE_LANE_ID } from "./initiative-lanes";
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
  /**
   * The ids of the Initiatives the board lists (the open ones). A drop on a
   * Project lane takes a card off its Initiative only when the Initiative is
   * in here, because only then was the card drawn on it.
   */
  readonly listedInitiativeIds: ReadonlySet<string>;
}

/** The part of a `DropMove` that says what a drop does to the Initiative of the cards. */
type InitiativeChange = NonNullable<DropMove["initiativeChange"]>;

/**
 * Returns the `initiativeId` field of the move of `card` for a drop with
 * `change`: empty when the drop changes nothing about its Initiative.
 */
const buildInitiativeField = (
  card: WorkCard,
  change: InitiativeChange | undefined,
): { readonly initiativeId?: string | null } => {
  if (change === undefined) return {};
  if (change.kind === "join") {
    return card.initiativeId === change.initiativeId ? {} : { initiativeId: change.initiativeId };
  }
  return card.initiativeId !== undefined && change.listedInitiativeIds.has(card.initiativeId)
    ? { initiativeId: null }
    : {};
};

/**
 * Returns the drop: the `task.move` it asks for, and the Project of the lane
 * it is let go on. The caller checks the drop with `settleDropMove`, then
 * shows and sends the move; a move that changes nothing is dropped there.
 *
 * - The stage is the request's, or the card's own for a drop on a lane's head.
 *   The move names it only when the card changes stage: a drop that reorders
 *   a column must not claim the stage, because the controller reads a stage
 *   in a move as the user's decision about it (it overrules any later-arriving
 *   fact about a linked thing). `targetStage` always carries it, for the cards
 *   dropped along.
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
 * - On an Initiative (a row, or a lane of Group by Initiative) the drop names
 *   the stage and `initiativeId`, never a Project, and no `afterTaskId`: the
 *   cells of such a lane hold cards of many Projects, so the card goes last in
 *   its own stored cell. `initiativeId` is named only when it changes.
 * - On "Not in an initiative" the drop works the same way, taking the card off
 *   its Initiative when it was drawn on one.
 * - On a Project lane the drop also takes a card off its Initiative, when it
 *   was drawn on one (`DropRequest.listedInitiativeIds`): a Project lane holds
 *   what is on no Initiative.
 * - On a folded lane there is no slot, so `afterTaskId` is absent and the
 *   card goes last in its cell.
 */
export const buildDropMove = (request: DropRequest): DropMove => {
  const { movingCard, lane, beforeCardId } = request;
  const stage = request.stage ?? movingCard.stage;
  const stageField = stage === movingCard.stage ? {} : { stage };
  if (lane.lane.outside !== undefined) {
    return { move: { taskId: movingCard.id, ...stageField }, targetStage: stage };
  }
  const { initiative } = lane.lane;
  const initiativeChange: InitiativeChange =
    initiative === undefined
      ? { kind: "leave", listedInitiativeIds: request.listedInitiativeIds }
      : { kind: "join", initiativeId: initiative.initiativeId };
  if (initiative !== undefined || lane.lane.id === NO_INITIATIVE_LANE_ID) {
    return {
      move: {
        taskId: movingCard.id,
        ...stageField,
        ...buildInitiativeField(movingCard, initiativeChange),
      },
      targetStage: stage,
      initiativeChange,
    };
  }
  const isOwnLane = lane.lane.cells.some((cell) =>
    cell.cards.some((card) => card.id === movingCard.id),
  );
  const move: CardMove = {
    taskId: movingCard.id,
    ...stageField,
    ...(isOwnLane ? {} : { projectId: lane.lane.projectId }),
    ...buildInitiativeField(movingCard, initiativeChange),
  };
  const targetProjectId = lane.lane.projectId;
  if (lane.isFolded) return { move, targetProjectId, targetStage: stage, initiativeChange };

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
  return {
    move: { ...move, afterTaskId },
    targetProjectId,
    targetStage: stage,
    initiativeChange,
  };
};

/**
 * Returns the moves of the cards carried along with the lead card of a drop,
 * in the order given. Each card lands right after the one before it, the
 * first right after the lead card (`leadMove`), so they keep their relative
 * order. On a folded lane the lead card has no card to follow, and each
 * follower goes last in the cell in turn, which gives the same order.
 *
 * A follower names the stage (`targetStage`) only when it stands in another
 * one, and a Project (`targetProjectId`) only when it stands in another one,
 * as the lead card's move does. A drop with no `targetProjectId`
 * (an outside lane, an Initiative) changes no Project, so no follower names
 * one. A follower names its Initiative by the same rule as the lead card
 * (`DropMove.initiativeChange`), and no `afterTaskId` when the lead card names none.
 */
export const buildFollowerMoves = (
  { move: leadMove, targetProjectId, targetStage = leadMove.stage, initiativeChange }: DropMove,
  followers: readonly WorkCard[],
): readonly CardMove[] => {
  let previousId = leadMove.taskId;
  return followers.map((card) => {
    const move: CardMove = {
      taskId: card.id,
      ...(targetStage === undefined || card.stage === targetStage ? {} : { stage: targetStage }),
      ...(targetProjectId === undefined || (card.projectId ?? null) === targetProjectId
        ? {}
        : { projectId: targetProjectId }),
      ...buildInitiativeField(card, initiativeChange),
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
    moves: [settled.move, ...buildFollowerMoves({ ...drop, move: settled.move }, present)],
    ...(notes.length === 0 ? {} : { note: notes.join(" ") }),
  };
};
