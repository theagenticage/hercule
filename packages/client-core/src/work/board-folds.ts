/**
 * What the user folded on the Work board, as one value, and every change to it.
 *
 * Three things fold: a lane, an Initiative row, and the block of rows On top
 * (the "Initiatives" heading). The user's choices live in two places:
 *
 * - `saved`: the choices made while no filter was on. They are kept between
 *   sessions. A lane is open unless it is in `foldedLaneIds`; a row is folded
 *   unless its Initiative is in `openedInitiativeIds`.
 * - `sinceFilter`: the folds made since a filter came on. A filter opens every
 *   lane and row so that nothing that matches hides behind a fold, so here a
 *   lane or row is open unless the user folded it. They last as long as the
 *   filter and are dropped when it changes or goes (`EMPTY_FILTER_FOLDS`).
 *
 * Which of the two answers is decided by `isFiltering`. Callers never look at
 * the sets themselves: they ask `isFolded` and change the value with the
 * functions here, which return a new value and leave the old one as it was.
 */
import type { WorkLane } from "./lanes";

/** What can fold: a lane, or an Initiative row. A `WorkLane` is one. */
export type FoldTarget = Pick<WorkLane, "id" | "initiative">;

/** The folds made while no filter is on. Kept between sessions. */
export interface SavedFolds {
  /** The ids of the folded lanes. */
  readonly foldedLaneIds: ReadonlySet<string>;
  /** The ids of the Initiatives whose row the user opened. Rows are folded unless their Initiative is in here. */
  readonly openedInitiativeIds: ReadonlySet<string>;
  /** Whether the block of rows On top is folded to its heading. */
  readonly isInitiativeBlockFolded: boolean;
}

/** The folds made since a filter came on. */
export interface FilterFolds {
  /** The ids of the lanes the user folded. */
  readonly foldedLaneIds: ReadonlySet<string>;
  /** The ids of the Initiatives whose row the user folded. */
  readonly foldedInitiativeIds: ReadonlySet<string>;
  /** Whether the user folded the block of rows On top. */
  readonly isInitiativeBlockFolded: boolean;
}

/** Everything the user folded, and whether a filter is on, which decides which half counts. */
export interface BoardFolds {
  /** Whether a filter or a Find text is on. */
  readonly isFiltering: boolean;
  readonly saved: SavedFolds;
  readonly sinceFilter: FilterFolds;
}

/** The folds of a filter that has just come on, or changed: none. */
export const EMPTY_FILTER_FOLDS: FilterFolds = {
  foldedLaneIds: new Set(),
  foldedInitiativeIds: new Set(),
  isInitiativeBlockFolded: false,
};

/** What `buildBoardFolds` takes. Anything left out is empty, open or false. */
export interface BoardFoldsInput {
  readonly isFiltering?: boolean;
  readonly saved?: {
    readonly foldedLaneIds?: Iterable<string>;
    readonly openedInitiativeIds?: Iterable<string>;
    readonly isInitiativeBlockFolded?: boolean;
  };
  readonly sinceFilter?: {
    readonly foldedLaneIds?: Iterable<string>;
    readonly foldedInitiativeIds?: Iterable<string>;
    readonly isInitiativeBlockFolded?: boolean;
  };
}

/** Returns the folds of `input`: what the screen holds, from what was saved and what is on. */
export const buildBoardFolds = ({
  isFiltering = false,
  saved = {},
  sinceFilter = {},
}: BoardFoldsInput = {}): BoardFolds => ({
  isFiltering,
  saved: {
    foldedLaneIds: new Set(saved.foldedLaneIds),
    openedInitiativeIds: new Set(saved.openedInitiativeIds),
    isInitiativeBlockFolded: saved.isInitiativeBlockFolded ?? false,
  },
  sinceFilter: {
    foldedLaneIds: new Set(sinceFilter.foldedLaneIds),
    foldedInitiativeIds: new Set(sinceFilter.foldedInitiativeIds),
    isInitiativeBlockFolded: sinceFilter.isInitiativeBlockFolded ?? false,
  },
});

/** Returns the id of the Initiative a row is for, or `undefined` when `target` is not a row. */
const readRowInitiativeId = (target: FoldTarget): string | undefined =>
  target.initiative?.isRow === true ? target.initiative.initiativeId : undefined;

/** Returns `ids` with `id` taken out when it is in, and put in when it is not. */
const toggleId = (ids: ReadonlySet<string>, id: string): ReadonlySet<string> => {
  const next = new Set(ids);
  if (!next.delete(id)) next.add(id);
  return next;
};

/**
 * Returns whether `target` shows folded. Without a filter a lane is open by
 * default and a row is folded by default; with one, both are open by default.
 */
export const isFolded = (folds: BoardFolds, target: FoldTarget): boolean => {
  const initiativeId = readRowInitiativeId(target);
  if (folds.isFiltering) {
    return initiativeId === undefined
      ? folds.sinceFilter.foldedLaneIds.has(target.id)
      : folds.sinceFilter.foldedInitiativeIds.has(initiativeId);
  }
  return initiativeId === undefined
    ? folds.saved.foldedLaneIds.has(target.id)
    : !folds.saved.openedInitiativeIds.has(initiativeId);
};

/**
 * Returns whether the block of rows On top is folded to its heading. With a
 * filter on, only a fold made since the filter came on counts, so that no
 * match hides behind it; the saved fold returns when the filter goes.
 */
export const isBlockFolded = (folds: BoardFolds): boolean =>
  folds.isFiltering
    ? folds.sinceFilter.isInitiativeBlockFolded
    : folds.saved.isInitiativeBlockFolded;

/**
 * Returns `folds` with `target` folded if it was open and open if it was
 * folded. With a filter on, the change lasts as long as the filter; otherwise
 * it is a saved choice.
 */
export const toggleFold = (folds: BoardFolds, target: FoldTarget): BoardFolds => {
  const initiativeId = readRowInitiativeId(target);
  if (folds.isFiltering) {
    const { sinceFilter } = folds;
    return {
      ...folds,
      sinceFilter:
        initiativeId === undefined
          ? { ...sinceFilter, foldedLaneIds: toggleId(sinceFilter.foldedLaneIds, target.id) }
          : {
              ...sinceFilter,
              foldedInitiativeIds: toggleId(sinceFilter.foldedInitiativeIds, initiativeId),
            },
    };
  }
  const { saved } = folds;
  return {
    ...folds,
    saved:
      initiativeId === undefined
        ? { ...saved, foldedLaneIds: toggleId(saved.foldedLaneIds, target.id) }
        : { ...saved, openedInitiativeIds: toggleId(saved.openedInitiativeIds, initiativeId) },
  };
};

/** Returns `folds` with the block of rows On top folded if it was open and open if it was folded. */
export const toggleBlockFold = (folds: BoardFolds): BoardFolds =>
  folds.isFiltering
    ? {
        ...folds,
        sinceFilter: {
          ...folds.sinceFilter,
          isInitiativeBlockFolded: !folds.sinceFilter.isInitiativeBlockFolded,
        },
      }
    : {
        ...folds,
        saved: { ...folds.saved, isInitiativeBlockFolded: !folds.saved.isInitiativeBlockFolded },
      };

/** What Fold everything does. */
export interface FoldEverythingPlan {
  /** Whether it opens (every lane was folded) or folds. */
  readonly isOpening: boolean;
  /** The folds once it is done. */
  readonly folds: BoardFolds;
  /** The targets that change from folded to open, or from open to folded. Motion plays these. */
  readonly changing: readonly FoldTarget[];
}

/** Returns whether `target` is an Initiative row. */
const isRow = (target: FoldTarget): boolean => readRowInitiativeId(target) !== undefined;

/** Plans Fold everything while a filter is on, when rows fold and open like lanes. */
const planFilteredFoldEverything = (
  folds: BoardFolds,
  targets: readonly FoldTarget[],
): Pick<FoldEverythingPlan, "isOpening" | "folds"> => {
  const isOpening = targets.every((target) => isFolded(folds, target));
  const foldedLaneIds = new Set(folds.sinceFilter.foldedLaneIds);
  const foldedInitiativeIds = new Set(folds.sinceFilter.foldedInitiativeIds);
  for (const target of targets) {
    const initiativeId = readRowInitiativeId(target);
    const ids = initiativeId === undefined ? foldedLaneIds : foldedInitiativeIds;
    if (isOpening) ids.delete(initiativeId ?? target.id);
    else ids.add(initiativeId ?? target.id);
  }
  const sinceFilter = { ...folds.sinceFilter, foldedLaneIds, foldedInitiativeIds };
  return { isOpening, folds: { ...folds, sinceFilter } };
};

/** Plans Fold everything with no filter on, when rows fold by leaving `openedInitiativeIds`. */
const planSavedFoldEverything = (
  folds: BoardFolds,
  targets: readonly FoldTarget[],
): Pick<FoldEverythingPlan, "isOpening" | "folds"> => {
  const lanes = targets.filter((target) => !isRow(target));
  const isOpening =
    lanes.every((lane) => isFolded(folds, lane)) && folds.saved.openedInitiativeIds.size === 0;
  const foldedLaneIds = new Set(folds.saved.foldedLaneIds);
  for (const lane of lanes) {
    if (isOpening) foldedLaneIds.delete(lane.id);
    else foldedLaneIds.add(lane.id);
  }
  const saved = { ...folds.saved, foldedLaneIds, openedInitiativeIds: new Set<string>() };
  return { isOpening, folds: { ...folds, saved } };
};

/**
 * Plans Fold everything over `targets`, every lane and row of the board.
 *
 * - With no filter, it opens every lane when all are folded and no row is
 *   open. Otherwise it folds every lane and closes every open row. Rows are
 *   not part of the question "is everything folded", only of the closing: they
 *   fold by leaving `openedInitiativeIds`, which it empties.
 * - With a filter on, rows are lanes: it opens all targets when all are
 *   folded, and folds them all otherwise.
 *
 * Plan it and commit `folds`, or play `changing` first and then commit.
 */
export const planFoldEverything = (
  folds: BoardFolds,
  targets: readonly FoldTarget[],
): FoldEverythingPlan => {
  const plan = folds.isFiltering
    ? planFilteredFoldEverything(folds, targets)
    : planSavedFoldEverything(folds, targets);
  return {
    ...plan,
    changing: targets.filter((target) => isFolded(folds, target) !== isFolded(plan.folds, target)),
  };
};
