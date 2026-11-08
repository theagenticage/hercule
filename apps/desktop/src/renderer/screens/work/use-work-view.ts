import { useState } from "react";
import { EMPTY_FILTER, isFilterOn, type Filter } from "@hercule/client-core/desk";
import type { CardInLane, InitiativePlace, WorkLane } from "@hercule/client-core/work";
import { readSavedWorkView, writeSavedWorkView, type SavedWorkView } from "./work-view-storage";

/** How the lanes label themselves: in a strip at the side, or in a band across the top. */
export type LaneLabels = "side-labels" | "bands";

/** The choices of the Display menu. */
export interface WorkDisplay {
  readonly laneLabels: LaneLabels;
  /** Where Group by Project draws the Initiative rows: all together above the lanes, or each under its Project's lane. */
  readonly initiativePlace: InitiativePlace;
  /** Whether the colleagues on the cards hold still: no typing paws, no blinking. */
  readonly isStill: boolean;
  /** Whether single keys, such as A and F, work on the board. */
  readonly hasSingleKeys: boolean;
}

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

/**
 * Returns the ids of the lanes that Fold everything folds. Rows fold by
 * `openedInitiativeIds`, which Fold everything empties by itself, so they are
 * left out; only while a filter is on, when rows open like lanes, do they fold
 * as lanes do.
 */
export const listFoldableLaneIds = (lanes: readonly WorkLane[], isFiltering: boolean): string[] =>
  lanes.filter((lane) => isFiltering || lane.initiative?.isRow !== true).map((lane) => lane.id);

/** Returns `ids` with `id` taken out when it is in, and put in when it is not. */
const toggleId = (ids: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  const next = new Set(ids);
  if (!next.delete(id)) next.add(id);
  return next;
};

/** How the user looks at the board: what `useWorkView` returns. */
export interface WorkView {
  /**
   * What the lanes group by: `PROJECT_FACET_ID`, or the kind of an outside
   * place. It may name a kind the board no longer has, which the screen
   * reads as Project.
   */
  readonly groupBy: string;
  readonly setGroupBy: (groupBy: string) => void;
  readonly display: WorkDisplay;
  readonly setDisplay: (display: WorkDisplay) => void;
  readonly filter: Filter;
  readonly setFilter: (filter: Filter) => void;
  readonly findText: string;
  readonly setFindText: (text: string) => void;
  /** Whether a filter or a Find text is on, which opens the folded lanes and lifts the limit of a cell. */
  readonly isFiltering: boolean;
  /** The ids (`buildCellId` in client-core) of the cells the user opened to show every card. */
  readonly openedCellIds: ReadonlySet<string>;
  readonly toggleCell: (cellId: string) => void;
  /**
   * The ids (`buildStackId` in client-core) of the stacks the user opened to
   * show their members. A stack with a question or a failure inside opens by
   * itself and is not recorded here.
   */
  readonly openedStackIds: ReadonlySet<string>;
  readonly toggleStack: (stackId: string) => void;
  /**
   * The ids of the lanes that show folded right now. While a filter is on,
   * lanes open whatever the user folded before, and this holds only the lanes
   * the user folded since the filter came on.
   */
  readonly foldedLaneIds: ReadonlySet<string>;
  readonly toggleLane: (laneId: string) => void;
  /**
   * The ids of the Initiatives whose row the user opened into cards. A row is
   * folded to its line of beads unless it is in here. While a filter is on,
   * rows are open whatever this holds (see `foldedLaneIds`).
   */
  readonly openedInitiativeIds: ReadonlySet<string>;
  /**
   * Folds or opens the row `rowLaneId` of the Initiative `initiativeId`. While
   * a filter is on, a row is open and the fold lasts as long as the filter,
   * as for a lane. Otherwise the choice is saved.
   */
  readonly toggleInitiativeRow: (rowLaneId: string, initiativeId: string) => void;
  /** Whether the user folded the block of rows On top, so that only its "Initiatives" heading shows. */
  readonly isInitiativeBlockFolded: boolean;
  readonly toggleInitiativeBlock: () => void;
  /**
   * Folds every lane in `laneIds` and closes every open Initiative row, or
   * opens the lanes when they are all folded and no row is open. While a
   * filter is on, `laneIds` also holds the rows, which then fold like lanes.
   */
  readonly foldEverything: (laneIds: readonly string[]) => void;
  /** The card the keyboard is on, or `null`. It may be a card that has left the board. */
  readonly currentCard: CardInLane | null;
  readonly setCurrentCard: (card: CardInLane | null) => void;
}

/**
 * Holds the client state of the Work board: the filter and the Find text,
 * which lanes are folded, which Initiative rows are open, which cells and stacks are opened, the Display choices, and
 * the current card.
 *
 * - How the lanes group, folds, open rows and Display are kept in `localStorage` under `storageKey` (see
 *   `work-view-storage.ts`). The filter, the Find text, the opened cells and stacks, and
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
  const [openedStackIds, setOpenedStackIds] = useState<ReadonlySet<string>>(new Set());
  const [currentCard, setCurrentCard] = useState<CardInLane | null>(null);

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
  const openedInitiativeIds = new Set(saved.openedInitiativeIds);
  const foldedLaneIds = isFiltering ? filterFolds : savedFolds;

  const changeFolds = (change: (ids: ReadonlySet<string>) => ReadonlySet<string>): void => {
    if (isFiltering) setFilterFolds(change(filterFolds));
    else save({ ...saved, foldedLaneIds: [...change(savedFolds)] });
  };

  return {
    groupBy: saved.groupBy,
    setGroupBy: (groupBy) => {
      save({ ...saved, groupBy });
    },
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
    openedStackIds,
    toggleStack: (stackId) => {
      setOpenedStackIds(toggleId(openedStackIds, stackId));
    },
    foldedLaneIds,
    toggleLane: (laneId) => {
      changeFolds((ids) => toggleId(ids, laneId));
    },
    openedInitiativeIds,
    toggleInitiativeRow: (rowLaneId, initiativeId) => {
      if (isFiltering) {
        setFilterFolds(toggleId(filterFolds, rowLaneId));
      } else {
        save({ ...saved, openedInitiativeIds: [...toggleId(openedInitiativeIds, initiativeId)] });
      }
    },
    isInitiativeBlockFolded: saved.isInitiativeBlockFolded,
    toggleInitiativeBlock: () => {
      save({ ...saved, isInitiativeBlockFolded: !saved.isInitiativeBlockFolded });
    },
    // Folding everything means everything: the rows the user opened close too.
    foldEverything: (laneIds) => {
      if (isFiltering) {
        setFilterFolds(foldOrOpenAll(filterFolds, laneIds));
        return;
      }
      const isOpening = laneIds.every((id) => savedFolds.has(id)) && openedInitiativeIds.size === 0;
      const folds = new Set(savedFolds);
      for (const id of laneIds) {
        if (isOpening) folds.delete(id);
        else folds.add(id);
      }
      save({ ...saved, foldedLaneIds: [...folds], openedInitiativeIds: [] });
    },
    currentCard,
    setCurrentCard,
  };
};
