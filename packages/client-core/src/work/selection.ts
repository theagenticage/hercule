/**
 * Selecting several cards of the Work board: which cards are selected, and
 * the words for what the user can do with them. The selection is a set of
 * Task ids that the Work screen holds; it never leaves the client.
 */
import type { EndStage } from "./card-change";

/** What the bar over the board says beside the count while more than one card is selected. */
export const SELECTION_DRAG_HINT = "Drag any of them to move them all";

/** Returns the selection with `cardId` added, or taken out when it was selected. The set given is not changed. */
export const toggleSelectedId = (
  selected: ReadonlySet<string>,
  cardId: string,
): ReadonlySet<string> => {
  const next = new Set(selected);
  if (!next.delete(cardId)) next.add(cardId);
  return next;
};

/**
 * Returns the selection without the ids that are not in `shownIds`, or the
 * selection itself when every id is. A card that leaves the board, or that the
 * board stops drawing, leaves the selection, so the count always matches the
 * cards the user can see marked.
 */
export const keepShownSelectedIds = (
  selected: ReadonlySet<string>,
  shownIds: readonly string[],
): ReadonlySet<string> => {
  if (selected.size === 0) return selected;
  const shown = new Set(shownIds);
  return [...selected].every((id) => shown.has(id))
    ? selected
    : new Set([...selected].filter((id) => shown.has(id)));
};

/** Returns the selected ids in the order the board draws them (`shownIds`), which is the order a bulk action works in. */
export const listSelectedIds = (
  selected: ReadonlySet<string>,
  shownIds: readonly string[],
): readonly string[] => shownIds.filter((id) => selected.has(id));

/** The word after the count in the bar over the board: `3` and `selected`. */
export const SELECTED_LABEL = "selected";

/** Returns the count as a screen reader hears it: `3 selected`. */
export const describeSelectedCount = (count: number): string =>
  `${String(count)} ${SELECTED_LABEL}`;

/**
 * Returns the words for ending several cards together, in the past tense, for
 * the undo line: `Marked 3 Tasks Done` or `Dropped 3 Tasks`.
 */
export const describeCardsEnd = (count: number, stage: EndStage): string =>
  stage === "done" ? `Marked ${String(count)} Tasks Done` : `Dropped ${String(count)} Tasks`;

/** What the undo line adds after several cards ended together: where they went. */
export const CARDS_ENDED_NOTE = "They have left the board.";

/** Returns the note for the undo line when Undo could not put `count` Tasks of a group back, so they stayed as they are. */
export const describeCardsLeftAsTheyAre = (count: number): string =>
  count === 1
    ? "1 Task could not be put back, so it stayed as it is."
    : `${String(count)} Tasks could not be put back, so they stayed as they are.`;
