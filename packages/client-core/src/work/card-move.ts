/**
 * Moving a card on the board, as the client sees it before the controller
 * answers: the projection of a move over the board, the two questions a
 * drop asks (which card to follow, and where a card stood before), and which
 * stage a key moves a card to.
 *
 * Order. The cards of `WorkBoard.cards` are in stored order: for one cell
 * (a Project and a stage), the order of their `boardRank`. The client does not
 * know the rank the controller will give a moved card, and it must not invent
 * one: a made-up rank would be compared with real ones later and misread. So
 * a projection changes the position of the card in the list, and leaves its
 * `boardRank` alone. Nothing on the client reads `boardRank`; the list order
 * is the order. A fresh read from the controller replaces the whole list, with
 * the real ranks, in the same order convention.
 */
import {
  BOARD_STAGES,
  type BoardStage,
  type TaskMoveInput,
  type WorkBoard,
  type WorkCard,
} from "@hercule/contract";
import type { WorkProject } from "./lanes";

/** One move of one card, as `task.move` takes it. */
export type CardMove = TaskMoveInput & { readonly taskId: string };

/** Returns whether `card` stands in the cell of `stage` and `projectId` (`undefined` for no Project). */
const isInCell = (card: WorkCard, stage: BoardStage, projectId: string | undefined): boolean =>
  card.stage === stage && card.projectId === projectId;

/** Returns the Project a move leaves the card in: the move's, or the current one when the move names none. */
const chooseProjectId = (moving: WorkCard, move: CardMove): string | undefined =>
  move.projectId === undefined ? moving.projectId : (move.projectId ?? undefined);

/**
 * Returns the index in `others` (the cards without the moving one) at which
 * the moving card goes, or `undefined` when the move names a card that is not
 * in the target cell.
 */
const findInsertIndex = (
  others: readonly WorkCard[],
  afterTaskId: string | null | undefined,
  inTargetCell: (card: WorkCard) => boolean,
): number | undefined => {
  if (afterTaskId === undefined) {
    const last = others.findLastIndex(inTargetCell);
    return last < 0 ? others.length : last + 1;
  }
  if (afterTaskId === null) {
    const first = others.findIndex(inTargetCell);
    return first < 0 ? others.length : first;
  }
  const after = others.findIndex((card) => card.id === afterTaskId);
  const afterCard = others[after];
  return afterCard !== undefined && inTargetCell(afterCard) ? after + 1 : undefined;
};

/**
 * Returns the board as it is once `move` is applied. It is a projection over
 * the board as the controller last gave it: it owns no request and no
 * snapshot, and a rolled back move is simply left out of the list that is
 * applied again.
 *
 * - The moved card changes `stage` and `projectId` as the move says, and goes
 *   after `afterTaskId` in the target cell, first for `null`, last when
 *   `afterTaskId` is absent. Its `boardRank` is left as it was (see the top of
 *   this file).
 * - Absent `afterTaskId` in the card's own cell, with no other change, does
 *   nothing, as in `task.move`.
 * - A move whose card is gone, or whose `afterTaskId` is gone or not in the
 *   target cell, returns the board itself. A pending move can be applied
 *   again over a newer board without ever failing.
 */
export const applyCardMove = (board: WorkBoard, move: CardMove): WorkBoard => {
  const moving = board.cards.find((card) => card.id === move.taskId);
  if (moving === undefined) return board;
  const stage = move.stage ?? moving.stage;
  const projectId = chooseProjectId(moving, move);
  if (move.afterTaskId === undefined && isInCell(moving, stage, projectId)) return board;

  const others = board.cards.filter((card) => card.id !== moving.id);
  const insertAt = findInsertIndex(others, move.afterTaskId, (card) =>
    isInCell(card, stage, projectId),
  );
  if (insertAt === undefined) return board;

  const { projectId: oldProjectId, ...withoutProject } = moving;
  void oldProjectId;
  const moved: WorkCard =
    projectId === undefined
      ? { ...withoutProject, stage }
      : { ...withoutProject, stage, projectId };
  return { ...board, cards: [...others.slice(0, insertAt), moved, ...others.slice(insertAt)] };
};

/**
 * Returns the board with every pending move applied over it, in order. Call it
 * on each fresh board from the controller, with the moves it has not yet
 * answered.
 */
export const reapplyCardMoves = (board: WorkBoard, moves: readonly CardMove[]): WorkBoard =>
  moves.reduce(applyCardMove, board);

/**
 * Where a card stood: its cell and the card it followed in stored order. A
 * gesture records it before it moves a card, so that Undo can move the card
 * back.
 */
export interface CardPlacement {
  readonly taskId: string;
  readonly stage: BoardStage;
  /** `null` for no Project. */
  readonly projectId: string | null;
  /** The card before it in its cell, in stored order. `null` when it was first. */
  readonly afterTaskId: string | null;
}

/** Returns where a card stands now, or `undefined` when the board has no such card. */
export const readPlacement = (board: WorkBoard, taskId: string): CardPlacement | undefined => {
  const card = board.cards.find((other) => other.id === taskId);
  if (card === undefined) return undefined;
  const cell = board.cards.filter((other) => isInCell(other, card.stage, card.projectId));
  const index = cell.findIndex((other) => other.id === taskId);
  return {
    taskId,
    stage: card.stage,
    projectId: card.projectId ?? null,
    afterTaskId: cell[index - 1]?.id ?? null,
  };
};

/**
 * The move that puts a card at a placement: back on the board after Undo, or
 * out of Done or Dropped. Also says whether it lands exactly there.
 */
export interface MoveToPlacement {
  readonly move: CardMove;
  /**
   * False when the card it followed is no longer in that cell. The card then
   * goes last in the cell, and the screen should say it was not put back
   * exactly.
   */
  readonly exact: boolean;
}

/**
 * Returns the move that puts a card at `placement`, over the board as it is
 * now. The card itself need not be on the board: it is not when a Task that
 * was marked Done comes back.
 *
 * The move always names `afterTaskId`: with the card's own cell unchanged, an
 * absent one would do nothing.
 */
export const buildMoveToPlacement = (
  board: WorkBoard,
  placement: CardPlacement,
): MoveToPlacement => {
  const cell = board.cards.filter(
    (card) =>
      card.id !== placement.taskId &&
      isInCell(card, placement.stage, placement.projectId ?? undefined),
  );
  const exact =
    placement.afterTaskId === null || cell.some((card) => card.id === placement.afterTaskId);
  const { taskId, stage, projectId } = placement;
  return {
    exact,
    move: {
      taskId,
      stage,
      projectId,
      afterTaskId: exact ? placement.afterTaskId : (cell.at(-1)?.id ?? null),
    },
  };
};

/**
 * Returns the move that puts a card back where `placement` says, over the
 * board as it is now. Returns `undefined` when the card is gone.
 */
export const buildRestoreMove = (
  board: WorkBoard,
  placement: CardPlacement,
): MoveToPlacement | undefined =>
  board.cards.some((card) => card.id === placement.taskId)
    ? buildMoveToPlacement(board, placement)
    : undefined;

/** What the undo line adds when a card could not be put exactly where it was meant to go: the card it followed is gone. */
export const CARD_NOT_EXACT_NOTE = "The card it followed has gone, so it went last in that stage.";

/**
 * A drop: the move it writes, and the Project of the lane it is let go on.
 * The move leaves `projectId` out for a drop in the card's own lane, so the
 * target Project is carried beside it, to check that it still exists.
 */
export interface DropMove {
  readonly move: CardMove;
  /** The Project of the lane the card is let go on, or `null` for the "No project" lane. */
  readonly targetProjectId: string | null;
}

/**
 * What to do with a drop's move once the board is as it is now: send it as it
 * is, send it with the card last in its cell and say so in `note`, or send
 * nothing and say why in `reason`.
 */
export type SettledDrop =
  | { readonly kind: "send"; readonly move: CardMove; readonly note?: string }
  | { readonly kind: "refuse"; readonly reason: string };

/**
 * Returns what to do with `drop`, built from the board the user saw while
 * carrying, over `board` as it is now. A push can change the board
 * during a carry, and a move that names a card that is gone would change
 * nothing and say nothing.
 *
 * - The Task is gone from `board`, or the Project of the lane the card was let
 *   go on is no longer one of `projects` (even when the move itself names no
 *   Project): nothing is sent, and `reason` says why.
 * - The card to follow is gone from the target cell: the card goes last in the
 *   cell, with `CARD_NOT_EXACT_NOTE` as the note.
 * - Otherwise the move is sent as it is.
 */
export const settleDropMove = (
  board: Pick<WorkBoard, "cards">,
  projects: readonly WorkProject[],
  { move, targetProjectId }: DropMove,
): SettledDrop => {
  const moving = board.cards.find((card) => card.id === move.taskId);
  if (moving === undefined) {
    return { kind: "refuse", reason: "The Task has left the board, so it was not moved." };
  }
  if (targetProjectId !== null && !projects.some((each) => each.id === targetProjectId)) {
    return {
      kind: "refuse",
      reason: "The Project it was dropped on has gone, so the card was not moved.",
    };
  }
  if (typeof move.afterTaskId !== "string") return { kind: "send", move };
  const stage = move.stage ?? moving.stage;
  const projectId = chooseProjectId(moving, move);
  const cell = board.cards.filter(
    (card) => card.id !== moving.id && isInCell(card, stage, projectId),
  );
  if (cell.some((card) => card.id === move.afterTaskId)) return { kind: "send", move };
  return {
    kind: "send",
    move: { ...move, afterTaskId: cell.at(-1)?.id ?? null },
    note: CARD_NOT_EXACT_NOTE,
  };
};

/** What a drop knows about the cell it lands in. */
export interface DropTarget {
  /** The cards of the target cell in stored order, without the card being moved. */
  readonly storedCell: readonly WorkCard[];
  /**
   * The card that follows the dropped card on screen, or `null` for the end of
   * the cell. When the drop is at the end of the cards shown and some are
   * hidden behind "13 more", this is the first hidden card, so the card lands
   * right after the last card shown and does not jump over cards the user has
   * not seen. It then waits behind "13 more" itself: a drop with the pointer
   * never asks for this place (the drag keeps a drop on the last row shown),
   * and a move by key may.
   */
  readonly nextVisibleCardId: string | null;
  /** Whether the card being moved has a failure. */
  readonly movingCardFailed: boolean;
}

/**
 * Returns the `afterTaskId` that `task.move` needs for a drop: the card the
 * dropped card follows in stored order, or `null` for the first place.
 *
 * `task.move` speaks stored order, and the screen does not show stored order:
 * a failed card floats to the top of its cell. So the card to follow is found
 * from the card that will follow the drop on screen, by its place in stored
 * order. A drop among the floating failed cards is the one case that needs
 * more: a card that is not failed goes to the top of the cards that do not
 * float, because that is where the screen will draw it.
 */
export const chooseAfterTaskId = (target: DropTarget): string | null => {
  const { storedCell } = target;
  let nextIndex =
    target.nextVisibleCardId === null
      ? -1
      : storedCell.findIndex((card) => card.id === target.nextVisibleCardId);
  if (nextIndex >= 0 && !target.movingCardFailed && storedCell[nextIndex]?.failure !== undefined) {
    nextIndex = storedCell.findIndex((card) => card.failure === undefined);
  }
  const predecessor = nextIndex < 0 ? storedCell.at(-1) : storedCell[nextIndex - 1];
  return predecessor?.id ?? null;
};

/**
 * A key that moves the card to another stage: one step to the stage before
 * (`-1`) or after (`1`), or straight to a given stage.
 */
export type StageChange =
  | { readonly kind: "shift-stage"; readonly direction: -1 | 1 }
  | { readonly kind: "pick-stage"; readonly stage: BoardStage };

/**
 * Returns the stage that `change` moves `card` to, or `undefined` when it
 * moves nowhere: the card already stands there, or it is at the first or last
 * stage and the change goes past it.
 */
export const chooseTargetStage = (
  card: Pick<WorkCard, "stage">,
  change: StageChange,
): BoardStage | undefined => {
  const target =
    change.kind === "pick-stage"
      ? change.stage
      : BOARD_STAGES[BOARD_STAGES.indexOf(card.stage) + change.direction];
  return target === card.stage ? undefined : target;
};
