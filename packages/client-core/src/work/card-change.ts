/**
 * The changes to the board that a user makes with a card and that the
 * controller has not answered yet, as the client projects them over the board
 * it last read. A move is in `card-move.ts`; this file adds the two other
 * things a card does: it ends (Done or Dropped, which leave the board) and it
 * returns (the Undo of an end).
 */
import type { WorkBoard, WorkCard } from "@hercule/contract";
import { dropClosingFullStops } from "../text";
import { applyCardMove, type CardMove } from "./card-move";
import { shortenTitle } from "./describe-card-move";

/** The two stages a Task ends at. The board draws neither. */
export type EndStage = "done" | "dropped";

/** One change of the board that is on its way to the controller. */
export type CardChange =
  /** The card moves. */
  | { readonly kind: "move"; readonly move: CardMove }
  /** The card ends and leaves the board; `card` is the card as it was. */
  | { readonly kind: "end"; readonly card: WorkCard; readonly stage: EndStage }
  /** A card that ended comes back, as `move` puts it; `card` is the card as it was before it ended. */
  | { readonly kind: "return"; readonly card: WorkCard; readonly move: CardMove };

/**
 * Returns the board without the card `taskId`, or the board itself when the
 * card is not on it. A pending end can be applied again over a newer board
 * without ever failing.
 */
export const applyCardEnd = (board: WorkBoard, taskId: string): WorkBoard =>
  board.cards.some((card) => card.id === taskId)
    ? { ...board, cards: board.cards.filter((card) => card.id !== taskId) }
    : board;

/**
 * Returns the board with `card` back on it, placed as `move` says. Returns the
 * board itself when the card is already on it, which is the case when a read
 * brought it back before this change was applied.
 */
export const applyCardReturn = (board: WorkBoard, card: WorkCard, move: CardMove): WorkBoard =>
  board.cards.some((each) => each.id === card.id)
    ? board
    : applyCardMove({ ...board, cards: [...board.cards, card] }, move);

/** Returns the board as it is once `change` is applied. */
export const applyCardChange = (board: WorkBoard, change: CardChange): WorkBoard => {
  switch (change.kind) {
    case "move":
      return applyCardMove(board, change.move);
    case "end":
      return applyCardEnd(board, change.card.id);
    case "return":
      return applyCardReturn(board, change.card, change.move);
  }
};

/**
 * Returns the board with every pending change applied over it, in order. Call
 * it on each fresh board from the controller, with the changes it has not yet
 * answered.
 */
export const reapplyCardChanges = (board: WorkBoard, changes: readonly CardChange[]): WorkBoard =>
  changes.reduce(applyCardChange, board);

/**
 * Returns the words for ending a card, in the past tense, for the undo line:
 * `Marked "Review PR" Done` or `Dropped "Review PR"`. A title longer than 32
 * characters is cut.
 */
export const describeCardEnd = (card: WorkCard, stage: EndStage): string =>
  stage === "done"
    ? `Marked "${shortenTitle(card.title)}" Done`
    : `Dropped "${shortenTitle(card.title)}"`;

/** What the undo line adds after an end: where the card went. */
export const CARD_ENDED_NOTE = "It has left the board.";

/**
 * Returns the sentence the undo line shows when the controller refused to end
 * a card, or could not be reached. `reason` is the controller's message, or
 * the error's.
 */
export const describeCardEndFailure = (card: WorkCard, stage: EndStage, reason: string): string => {
  const what =
    stage === "done"
      ? `Marking "${shortenTitle(card.title)}" Done`
      : `Dropping "${shortenTitle(card.title)}"`;
  return `${what} did not save, so the card came back: ${dropClosingFullStops(reason)}. Try again.`;
};
