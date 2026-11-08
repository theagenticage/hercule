import type { BoardStage, WorkCard } from "@hercule/contract";

/** A cell of the board: a stage, in a Project (`null` for no Project). */
export interface CardCell {
  readonly stage: BoardStage;
  readonly projectId: string | null;
}

/** Why a card is in its stage, as `WorkCard.stageCause` has it. */
export type StageCause = NonNullable<WorkCard["stageCause"]>;

/** What `listCardMoves` reads of a card: where it stands, and why. */
export type PlacedCard = Pick<WorkCard, "id" | "stage" | "projectId" | "stageCause">;

/** What `listCardMoves` reads of a board. A `WorkBoard` is one, and so is a snapshot of one. */
export interface PlacedCards {
  readonly cards: readonly PlacedCard[];
}

/**
 * What happened to one card between two reads of the board:
 *
 * - `arrived`: the card is on the new board and was not on the old one.
 * - `moved`: the card changed stage. `cause` is the card's `stageCause` on the
 *   new board, so a move that a fact about a linked thing made carries its
 *   words ("Pull request #6221 merged") and a drag from another client carries none.
 * - `left`: the card was on the old board and is not on the new one (it ended,
 *   or it was merged into another Task).
 */
export type CardStageChange =
  | { readonly kind: "arrived"; readonly cardId: string; readonly to: CardCell }
  | {
      readonly kind: "moved";
      readonly cardId: string;
      readonly from: CardCell;
      readonly to: CardCell;
      readonly cause?: StageCause;
    }
  | { readonly kind: "left"; readonly cardId: string; readonly from: CardCell };

/** Returns the cell `card` stands in. */
const readCell = (card: PlacedCard): CardCell => ({
  stage: card.stage,
  projectId: card.projectId ?? null,
});

/**
 * Returns what happened to each card between the board `previous` and the
 * board `next`, to play it as motion: a card moving by itself when a fact
 * arrives, or the morning replay of what changed since the board was last
 * seen.
 *
 * - A card that changed stage is `moved`. A card that only changed Project, or
 *   only its place in a cell, is not listed: nothing here is about it.
 * - The list follows `next.cards` for `arrived` and `moved`, then the cards
 *   that `left`, in the order of `previous.cards`. The order is the same for
 *   the same two boards.
 * - The two boards are compared whole. A board cut short by its `truncated`
 *   flag makes the cards past the cut look as if they left or arrived, so the
 *   caller should not compare a truncated board with a whole one.
 */
export const listCardMoves = (
  previous: PlacedCards,
  next: PlacedCards,
): readonly CardStageChange[] => {
  const before = new Map(previous.cards.map((card) => [card.id, card]));
  const nextIds = new Set(next.cards.map((card) => card.id));
  const changes: CardStageChange[] = [];
  for (const card of next.cards) {
    const old = before.get(card.id);
    if (old === undefined) {
      changes.push({ kind: "arrived", cardId: card.id, to: readCell(card) });
    } else if (old.stage !== card.stage) {
      changes.push({
        kind: "moved",
        cardId: card.id,
        from: readCell(old),
        to: readCell(card),
        ...(card.stageCause === undefined ? {} : { cause: card.stageCause }),
      });
    }
  }
  for (const card of previous.cards) {
    if (!nextIds.has(card.id))
      changes.push({ kind: "left", cardId: card.id, from: readCell(card) });
  }
  return changes;
};
