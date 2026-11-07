import { useState } from "react";
import { keepShownSelectedIds, listSelectedIds, toggleSelectedId } from "@hercule/client-core/work";

/** What `useCardSelection` returns. */
export interface CardSelection {
  /** The ids of the selected cards, all of them cards the board draws. */
  readonly selectedIds: ReadonlySet<string>;
  /** The selected ids in the order the board draws them, which is the order a bulk action works in. */
  readonly listSelected: () => readonly string[];
  /** Selects the card `cardId`, or takes it out of the selection when it is in. */
  readonly toggle: (cardId: string) => void;
  /** Empties the selection. */
  readonly clear: () => void;
}

/**
 * Holds which cards of the Work board are selected, as a set of Task ids. The
 * selection is client state of the screen: it is not in the address and it is
 * not kept when the screen goes away.
 *
 * `shownIds` are the cards the board draws now. A card that leaves them (it
 * was marked Done, merged away, filtered out, or its lane was folded) leaves
 * the selection too, so the count always matches the marked cards the user can
 * see and a bulk action never touches a card out of sight.
 */
export const useCardSelection = (shownIds: readonly string[]): CardSelection => {
  const [chosenIds, setChosenIds] = useState<ReadonlySet<string>>(new Set());
  // The cards that left are written back out at once, so a card that comes
  // back later does not come back selected.
  const selectedIds = keepShownSelectedIds(chosenIds, shownIds);
  if (selectedIds !== chosenIds) setChosenIds(selectedIds);
  return {
    selectedIds,
    listSelected: () => listSelectedIds(selectedIds, shownIds),
    toggle: (cardId) => {
      setChosenIds(toggleSelectedId(selectedIds, cardId));
    },
    clear: () => {
      setChosenIds(new Set());
    },
  };
};
