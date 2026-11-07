import { useState } from "react";
import { EMPTY_FILTER, isFilterOn, type Filter } from "@hercule/client-core/desk";
import type { BoardStage } from "@hercule/contract";
import { readSavedWorkView, writeSavedWorkView, type SavedWorkView } from "./work-view-storage";

/** How the lanes label themselves: in a strip at the side, or in a band across the top. */
export type LaneLabels = "side-labels" | "bands";

/** The choices of the Display menu. */
export interface WorkDisplay {
  readonly laneLabels: LaneLabels;
  /** Whether the colleagues on the cards hold still: no typing paws, no blinking. */
  readonly isStill: boolean;
  /** Whether single keys, such as A and F, work on the board. */
  readonly hasSingleKeys: boolean;
}

/** Returns the id of one cell of the board, the key `openedCellIds` holds. */
export const buildCellId = (laneId: string, stage: BoardStage): string => `${laneId}/${stage}`;

/**
 * Returns the ids with every one of `laneIds` taken out when all of them are
 * in `ids`, and with all of them put in otherwise. It is Fold everything: it
 * opens every lane when all are folded, and folds every lane when any is open.
 */
const foldOrOpenAll = (
  ids: ReadonlySet<string>,
  laneIds: readonly string[],
): ReadonlySet<string> => {
  const next = new Set(ids);
  const allFolded = laneIds.every((id) => ids.has(id));
  for (const id of laneIds) {
    if (allFolded) next.delete(id);
    else next.add(id);
  }
  return next;
};

/** Returns `ids` with `id` taken out when it is in, and put in when it is not. */
const toggleId = (ids: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  const next = new Set(ids);
  if (!next.delete(id)) next.add(id);
  return next;
};

/** How the user looks at the board: what `useWorkView` returns. */
export interface WorkView {
  readonly display: WorkDisplay;
  readonly setDisplay: (display: WorkDisplay) => void;
  readonly filter: Filter;
  readonly setFilter: (filter: Filter) => void;
  readonly findText: string;
  readonly setFindText: (text: string) => void;
  /** Whether a filter or a Find text is on, which opens the folded lanes and lifts the limit of a cell. */
  readonly isFiltering: boolean;
  /** The ids (`buildCellId`) of the cells the user opened to show every card. */
  readonly openedCellIds: ReadonlySet<string>;
  readonly toggleCell: (cellId: string) => void;
  /**
   * The ids of the lanes that show folded right now. While a filter is on,
   * lanes open whatever the user folded before, and this holds only the lanes
   * the user folded since the filter came on.
   */
  readonly foldedLaneIds: ReadonlySet<string>;
  readonly toggleLane: (laneId: string) => void;
  /** Folds every lane in `laneIds`, or opens them when they are all folded. */
  readonly foldEverything: (laneIds: readonly string[]) => void;
  /** The card the keyboard is on, or `null`. It may be a card that has left the board. */
  readonly currentCardId: string | null;
  readonly setCurrentCardId: (cardId: string | null) => void;
}

/**
 * Holds the client state of the Work board: the filter and the Find text,
 * which lanes are folded, which cells are opened, the Display choices, and
 * the current card.
 *
 * - Folds and Display are kept in `localStorage` under `storageKey` (see
 *   `work-view-storage.ts`). The filter, the Find text, the opened cells and
 *   the current card are not: they are about what the user is doing now.
 * - A fold made while a filter is on lasts as long as the filter does: it is
 *   kept apart from the saved folds, and dropped when the filter changes or
 *   goes.
 */
export const useWorkView = (storageKey: string): WorkView => {
  const [saved, setSaved] = useState(() => readSavedWorkView(storageKey));
  const [filter, setFilterState] = useState<Filter>(EMPTY_FILTER);
  const [findText, setFindTextState] = useState("");
  const [filterFolds, setFilterFolds] = useState<ReadonlySet<string>>(new Set());
  const [openedCellIds, setOpenedCellIds] = useState<ReadonlySet<string>>(new Set());
  const [currentCardId, setCurrentCardId] = useState<string | null>(null);

  const isFiltering = isFilterOn(filter) || findText.trim() !== "";

  const save = (next: SavedWorkView): void => {
    setSaved(next);
    writeSavedWorkView(storageKey, next);
  };

  const setFilter = (next: Filter): void => {
    setFilterState(next);
    setFilterFolds(new Set());
  };

  const setFindText = (text: string): void => {
    setFindTextState(text);
    if ((text.trim() === "") !== (findText.trim() === "")) setFilterFolds(new Set());
  };

  const savedFolds = new Set(saved.foldedLaneIds);
  const foldedLaneIds = isFiltering ? filterFolds : savedFolds;

  const changeFolds = (change: (ids: ReadonlySet<string>) => ReadonlySet<string>): void => {
    if (isFiltering) setFilterFolds(change(filterFolds));
    else save({ ...saved, foldedLaneIds: [...change(savedFolds)] });
  };

  return {
    display: saved.display,
    setDisplay: (display) => {
      save({ ...saved, display });
    },
    filter,
    setFilter,
    findText,
    setFindText,
    isFiltering,
    openedCellIds,
    toggleCell: (cellId) => {
      setOpenedCellIds(toggleId(openedCellIds, cellId));
    },
    foldedLaneIds,
    toggleLane: (laneId) => {
      changeFolds((ids) => toggleId(ids, laneId));
    },
    foldEverything: (laneIds) => {
      changeFolds((ids) => foldOrOpenAll(ids, laneIds));
    },
    currentCardId,
    setCurrentCardId,
  };
};
