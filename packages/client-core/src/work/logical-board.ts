/**
 * The logical board: what the Work board is right now, as the user sees it
 * when the screen holds nothing back. It is the one board that every action
 * (a drop, Done, a merge, a key, the details pane) reads, so they cannot
 * disagree about where a card is or whether it is still there.
 *
 * The screen draws a second board, the drawn board, which is this one with
 * the changes nobody here caused held back until the hand is still
 * (`holdBackBoardChanges`). The drawn board is for the eyes only.
 */
import type { WorkBoard } from "@hercule/contract";
import { reapplyCardChanges, type CardChange } from "./card-change";
import { showHeldAnswers, type HeldAnswerTarget } from "./held-answers";
import { hideHeldMergeSources, type HeldMerge } from "./merge";

/** What the user did that the controller has not answered yet, and that the board must already show. */
export interface PendingBoardChanges {
  /** Card moves, ends and returns on their way to the controller, oldest first. */
  readonly changes: readonly CardChange[];
  /** The answers held for the undo line: their cards show the question as answered. */
  readonly heldAnswers: readonly HeldAnswerTarget[];
  /** The merges held for the undo line: their cards are not on the board. */
  readonly heldMerges: readonly HeldMerge[];
}

/** The logical board, and the Tasks it leaves out on purpose. */
export interface LogicalBoard {
  readonly board: WorkBoard;
  /**
   * The Tasks that are on the server board but that the user's own gestures
   * took off this one (the source of a held merge). Their card is not a new
   * Task when it comes back (the merge was undone or refused): the drawn
   * board shows it at once instead of holding it back as an arrival.
   */
  readonly hiddenIds: ReadonlySet<string>;
  /**
   * The Tasks whose stage the user moved and the controller has not answered
   * yet. The drawn board never holds such a card back at the stage it had
   * (`holdBackBoardChanges`): the user chose where it is.
   */
  readonly movedIds: ReadonlySet<string>;
}

/**
 * Returns the logical board: `serverBoard` with the pending changes applied,
 * in this order.
 *
 * 1. `changes` move, end and return cards (`reapplyCardChanges`).
 * 2. `heldAnswers` take the question off the cards they answer (`showHeldAnswers`).
 * 3. `heldMerges` remove the cards that merge away (`hideHeldMergeSources`).
 *
 * Returns the server board itself when there is nothing pending, and keeps
 * every card object that no step changes, so a card that did not change is
 * not drawn again.
 */
export const buildLogicalBoard = (
  serverBoard: WorkBoard,
  { changes, heldAnswers, heldMerges }: PendingBoardChanges,
): LogicalBoard => {
  const placed = reapplyCardChanges(serverBoard, changes);
  const answered = showHeldAnswers(placed.cards, heldAnswers);
  const cards = hideHeldMergeSources(answered, heldMerges);
  const board = cards === placed.cards ? placed : { ...placed, cards };
  const hiddenIds = new Set(
    heldMerges.map((merge) => merge.taskId).filter((id) => answered.some((card) => card.id === id)),
  );
  const movedIds = new Set(
    changes.flatMap((change) =>
      change.kind === "move" && change.move.stage !== undefined ? [change.move.taskId] : [],
    ),
  );
  return { board, hiddenIds, movedIds };
};
