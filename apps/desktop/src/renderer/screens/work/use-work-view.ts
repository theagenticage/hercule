import { useState } from "react";
import { EMPTY_FILTER, isFilterOn, type Filter } from "@hercule/client-core/desk";
import {
  buildBoardFolds,
  EMPTY_FILTER_FOLDS,
  planFoldEverything,
  toggleBlockFold,
  toggleFold,
  type BoardFolds,
  type CardInLane,
  type FilterFolds,
  type FoldTarget,
  type InitiativePlace,
} from "@hercule/client-core/work";
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
   * What the user folded, as one value: ask it with `isFolded` and
   * `isBlockFolded` from client-core. While a filter is on, lanes and rows
   * open whatever the user folded before, and it answers for the folds made
   * since the filter came on.
   */
  readonly folds: BoardFolds;
  /**
   * Folds or opens a lane or an Initiative row. While a filter is on, the fold
   * lasts as long as the filter. Otherwise the choice is saved.
   */
  readonly toggleFold: (target: FoldTarget) => void;
  /** Folds or opens the block of rows On top. While a filter is on the fold lasts as long as the filter. */
  readonly toggleInitiativeBlock: () => void;
  /**
   * Folds every one of `targets`, every lane and row of the board, and closes
   * every open Initiative row, or opens the lanes when they are all folded and
   * no row is open (see `planFoldEverything`).
   */
  readonly foldEverything: (targets: readonly FoldTarget[]) => void;
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
 *   goes. That holds for lanes, for rows and for the block of rows On top.
 * - `listedInitiativeIds` are the ids of the Initiatives the board lists, or
 *   `undefined` until the list is read. Opened rows of any other Initiative
 *   (closed or deleted since) are not reported and are dropped from what is
 *   saved the next time anything is saved.
 */
export const useWorkView = (
  storageKey: string,
  listedInitiativeIds: readonly string[] | undefined,
): WorkView => {
  const [saved, setSaved] = useState(() => readSavedWorkView(storageKey));
  const [filter, setFilterState] = useState<Filter>(EMPTY_FILTER);
  const [findText, setFindTextState] = useState("");
  const [filterFolds, setFilterFolds] = useState<FilterFolds>(EMPTY_FILTER_FOLDS);
  const [openedCellIds, setOpenedCellIds] = useState<ReadonlySet<string>>(new Set());
  const [openedStackIds, setOpenedStackIds] = useState<ReadonlySet<string>>(new Set());
  const [currentCard, setCurrentCard] = useState<CardInLane | null>(null);

  const isFiltering = isFilterOn(filter) || findText.trim() !== "";

  const listed = listedInitiativeIds === undefined ? undefined : new Set(listedInitiativeIds);
  const isListed = (id: string): boolean => listed === undefined || listed.has(id);

  const save = (next: SavedWorkView): void => {
    const pruned = { ...next, openedInitiativeIds: next.openedInitiativeIds.filter(isListed) };
    setSaved(pruned);
    writeSavedWorkView(storageKey, pruned);
  };

  const setFilter = (next: Filter): void => {
    setFilterState(next);
    setFilterFolds(EMPTY_FILTER_FOLDS);
  };

  const setFindText = (text: string): void => {
    setFindTextState(text);
    if ((text.trim() === "") !== (findText.trim() === "")) setFilterFolds(EMPTY_FILTER_FOLDS);
  };

  const folds = buildBoardFolds({
    isFiltering,
    saved: {
      foldedLaneIds: saved.foldedLaneIds,
      openedInitiativeIds: saved.openedInitiativeIds.filter(isListed),
      isInitiativeBlockFolded: saved.isInitiativeBlockFolded,
    },
    sinceFilter: filterFolds,
  });

  // A fold made while filtering lasts as long as the filter; any other is saved.
  const commitFolds = (next: BoardFolds): void => {
    if (next.isFiltering) {
      setFilterFolds(next.sinceFilter);
      return;
    }
    save({
      ...saved,
      foldedLaneIds: [...next.saved.foldedLaneIds],
      openedInitiativeIds: [...next.saved.openedInitiativeIds],
      isInitiativeBlockFolded: next.saved.isInitiativeBlockFolded,
    });
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
    folds,
    toggleFold: (target) => {
      commitFolds(toggleFold(folds, target));
    },
    toggleInitiativeBlock: () => {
      commitFolds(toggleBlockFold(folds));
    },
    foldEverything: (targets) => {
      commitFolds(planFoldEverything(folds, targets).folds);
    },
    currentCard,
    setCurrentCard,
  };
};
