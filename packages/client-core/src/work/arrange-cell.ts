/**
 * What one cell of the Work board shows. The rules, from the design's "Rows
 * at rest":
 *
 * - A cell shows four cards. A fifth is shown rather than hidden. Past that
 *   the rest wait behind a line, "13 more", that opens them in place.
 * - A card with an open question or a failure is always shown, also past the
 *   fourth row.
 * - A failed card leads its cell. Failed cards keep their stored order among
 *   themselves, and so do all the others.
 * - A filter, or a Find text, lifts the limit.
 * - Landed shows as a line, "3 landed", that opens the same way. A card with a
 *   question or a failure in Landed is shown as a card above that line.
 *
 * Arranging only chooses what to draw. It does not change `boardRank`.
 */
import type { BoardStage, WorkCard } from "@hercule/contract";

/** The most cards a cell shows before it hides any (the Landed cell shows none). */
export const ROWS_BEFORE_HIDING = 4;

/** A cell with this many cards or fewer shows all of them: the fifth is shown rather than hidden. */
const MOST_CARDS_SHOWN_WHOLE = ROWS_BEFORE_HIDING + 1;

/**
 * The line under the cards of a cell:
 *
 * - `none`: no line;
 * - `more`: "13 more", which opens the hidden cards;
 * - `landed`: "3 landed", the same for the Landed cell;
 * - `fewer`: "Show fewer", which closes an opened cell.
 */
export type CellFoot = "none" | "more" | "landed" | "fewer";

/** What a cell shows. */
export interface ArrangedCell {
  /** The cards to draw, top to bottom. */
  readonly cards: readonly WorkCard[];
  /** The cards not drawn, in stored order. Their number is the count on a `more` or `landed` line. */
  readonly hiddenCards: readonly WorkCard[];
  readonly foot: CellFoot;
}

/** How the user looks at a cell. */
export interface CellView {
  readonly stage: BoardStage;
  /** Whether the user opened the hidden cards of this cell. */
  readonly opened: boolean;
  /** Whether a filter or a Find text is on. */
  readonly filtered: boolean;
}

const isFailed = (card: WorkCard): boolean => card.failure !== undefined;

/** Returns whether a card must never wait out of sight: it has a question or a failure. */
export const isLoudCard = (card: WorkCard): boolean =>
  isFailed(card) || card.openQuestion !== undefined;

/** Returns the arrangement of a cell that is not opened. */
const arrangeClosed = (ordered: readonly WorkCard[], stage: BoardStage): ArrangedCell => {
  if (stage !== "landed" && ordered.length <= MOST_CARDS_SHOWN_WHOLE) {
    return { cards: ordered, hiddenCards: [], foot: "none" };
  }
  const lead = stage === "landed" ? [] : ordered.slice(0, ROWS_BEFORE_HIDING);
  const rest = stage === "landed" ? ordered : ordered.slice(ROWS_BEFORE_HIDING);
  const hiddenCards = rest.filter((card) => !isLoudCard(card));
  return {
    cards: [...lead, ...rest.filter(isLoudCard)],
    hiddenCards,
    foot: hiddenCards.length === 0 ? "none" : stage === "landed" ? "landed" : "more",
  };
};

/**
 * Returns what the cell shows. `cards` are the cards of the cell in stored
 * order, as `buildLanes` returns them. The result lists the cards to draw,
 * the cards left out and the line under them.
 *
 * An opened cell has a `fewer` line only when closing it would hide
 * something, so a cell of three never offers "Show fewer".
 */
export const arrangeCell = (cards: readonly WorkCard[], view: CellView): ArrangedCell => {
  const ordered = [...cards.filter(isFailed), ...cards.filter((card) => !isFailed(card))];
  if (view.filtered) return { cards: ordered, hiddenCards: [], foot: "none" };
  const closed = arrangeClosed(ordered, view.stage);
  if (!view.opened || closed.hiddenCards.length === 0) return closed;
  return { cards: ordered, hiddenCards: [], foot: "fewer" };
};
