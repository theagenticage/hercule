/**
 * The whole Work board as the screen draws it, worked out once. Everything
 * that asks what is on screen reads the result: the drawing of the lanes, the
 * keyboard walk, a drop, the selection, the counts over the stages, the words
 * under each Initiative row, and whether the board is empty. None of them can
 * disagree, because none of them works it out again.
 */
import type { BoardStage, WorkBoard, WorkCard, WorkStackCandidate } from "@hercule/contract";
import { arrangeLane, arrangeLanes, countCardsByStage, type ArrangedLane } from "./arrange-lanes";
import { isBlockFolded, type BoardFolds } from "./board-folds";
import { groupBoardByContext, listBoardGroupings, type BoardGrouping } from "./context-lanes";
import { INITIATIVE_FACET_ID, PROJECT_FACET_ID } from "./facets";
import {
  groupBoardByInitiative,
  groupBoardByProject,
  type InitiativePlace,
} from "./initiative-lanes";
import { computeInitiativeProgress, describeInitiativeFacts } from "./initiative-progress";
import type { GroupedLanes, WorkInitiative, WorkProject } from "./lanes";
import { listShownCards, type CardInLane } from "./walk";

const NO_COUNTS: Readonly<Record<string, number>> = {};
const NO_CANDIDATES: readonly WorkStackCandidate[] = [];

/** What `arrangeBoard` reads. */
export interface ArrangeBoardInput {
  /**
   * The board that is true now, with the user's pending changes applied, or
   * `undefined` until it is read. The words under each row ("2 of 8 landed")
   * are counted from it and from every one of its cards, not from the ones the
   * filter leaves, so they say the same whatever the user looks for and a Task
   * the user just marked Done keeps counting.
   */
  readonly logicalBoard: Pick<WorkBoard, "cards" | "initiativeDoneCounts"> | undefined;
  /**
   * The board as it is drawn, or `undefined` until it can be: the logical
   * board with arrivals and failures held back for a still hand. Its places,
   * groupings and stack candidates decide how the lanes are made, and its Done
   * counts give a row its rings.
   */
  readonly drawnBoard:
    | Pick<WorkBoard, "cards" | "places" | "groupings" | "stackCandidates" | "initiativeDoneCounts">
    | undefined;
  /** The cards of `drawnBoard` that the filter and Find leave. These are the cards the lanes hold. */
  readonly visibleCards: readonly WorkCard[];
  readonly projects: readonly WorkProject[];
  /** The open Initiatives. */
  readonly initiatives: readonly WorkInitiative[];
  /**
   * What the user chose to group by: `PROJECT_FACET_ID`, `INITIATIVE_FACET_ID`,
   * or the kind of an outside place. A choice the board cannot draw is drawn as
   * Project (see `ArrangedBoard.groupBy`).
   */
  readonly requestedGroupBy: string;
  /** Where Group by Project draws the Initiative rows. */
  readonly place: InitiativePlace;
  readonly folds: BoardFolds;
  /** The ids (`buildCellId`) of the cells the user opened to show every card. */
  readonly openedCellIds: ReadonlySet<string>;
  /** The ids (`buildStackId`) of the stacks the user opened. */
  readonly openedStackIds: ReadonlySet<string>;
}

/** The block of Initiative rows drawn above the lanes (Group by Project, On top). */
export interface ArrangedBlock {
  /** Every row of the block. While the block is folded none of them is drawn, but the heading counts them. */
  readonly rows: readonly ArrangedLane[];
  /** Whether the block is folded to its heading. */
  readonly isFolded: boolean;
}

/** The Work board, arranged. */
export interface ArrangedBoard {
  /** The grouping drawn: the requested one, or Project when the board cannot draw it. */
  readonly groupBy: string;
  /** The groupings the board offers, for the Group by menu. */
  readonly groupings: readonly BoardGrouping[];
  /** The Initiative rows On top, or `null` when there are none. */
  readonly block: ArrangedBlock | null;
  /**
   * The lanes under the block, in drawing order. Under Group by Project In
   * lanes, each holds its Initiative rows in `ArrangedLane.rows`.
   */
  readonly lanes: readonly ArrangedLane[];
  /**
   * Every lane and row of the board, hidden or not: the rows of a block or
   * of a lane that a fold hides are in here. In drawing order, each lane
   * followed by its rows.
   */
  readonly everyLane: readonly ArrangedLane[];
  /**
   * The lanes and rows that are on screen, in drawing order, each Project lane
   * followed by its rows. A fold hides rows, and what is hidden is not on
   * screen: the keyboard walk, a drop and the selection must not reach it.
   */
  readonly drawnLanes: readonly ArrangedLane[];
  /** Every card on screen, lane by lane, column by column, top to bottom. */
  readonly shownCards: readonly CardInLane[];
  /** How many Tasks stand at each stage, shown or not, or `null` until the board is drawn. */
  readonly stageCounts: Readonly<Record<BoardStage, number>> | null;
  /** The words under the name of each row, by the id of its Initiative. Absent for a row with no facts to tell. */
  readonly factsByInitiativeId: ReadonlyMap<string, string | null>;
  /**
   * Whether the board is empty: it is drawn, holds no card, and draws no
   * Initiative. Group by Project and Group by Initiative draw every listed
   * Initiative, with or without a Task, so a board with no card is not empty
   * while one is listed.
   */
  readonly isEmpty: boolean;
  /** Returns the lane or row with this id, hidden or not, or `undefined` when there is none. */
  readonly findLane: (laneId: string) => ArrangedLane | undefined;
}

/**
 * Returns the grouping to draw. A grouping whose kind the board no longer has
 * (its plugin was removed, or none of its places is on the board), or
 * Initiative once no Initiative is open, is drawn as Project; the choice stays
 * saved in case it comes back.
 */
const resolveGroupBy = (
  requested: string,
  groupings: readonly BoardGrouping[],
  initiativeCount: number,
): string =>
  groupings.some((grouping) => grouping.kind === requested) ||
  (requested === INITIATIVE_FACET_ID && initiativeCount > 0)
    ? requested
    : PROJECT_FACET_ID;

/** Returns the lanes the grouping `groupBy` makes of the visible cards, with their rows. */
const groupLanes = (input: ArrangeBoardInput, groupBy: string): GroupedLanes => {
  const { drawnBoard, visibleCards, projects, initiatives, place, folds } = input;
  if (groupBy === PROJECT_FACET_ID) {
    return groupBoardByProject(
      {
        cards: visibleCards,
        initiativeDoneCounts: drawnBoard?.initiativeDoneCounts ?? NO_COUNTS,
      },
      projects,
      initiatives,
      { place, isFiltering: folds.isFiltering },
    );
  }
  const lanes =
    groupBy === INITIATIVE_FACET_ID
      ? groupBoardByInitiative({ cards: visibleCards }, initiatives, {
          isFiltering: folds.isFiltering,
        })
      : groupBoardByContext(
          {
            cards: visibleCards,
            places: drawnBoard?.places ?? [],
            groupings: drawnBoard?.groupings ?? [],
          },
          groupBy,
        );
  return { topRows: [], groups: lanes.map((lane) => ({ lane, rows: [] })) };
};

/**
 * Arranges the Work board: groups the visible cards into lanes by the
 * grouping to draw, nests the Initiative rows in their two containers (the
 * block On top, or under their Project's lane), and works out under the user's
 * folds and opened cells what each lane shows.
 *
 * It reads the logical board and the drawn board separately, on purpose. What
 * is on screen comes from the drawn board and the visible cards; what is true
 * (an Initiative's progress) comes from the logical board.
 */
export const arrangeBoard = (input: ArrangeBoardInput): ArrangedBoard => {
  const { logicalBoard, drawnBoard, initiatives, folds } = input;
  const groupings = listBoardGroupings({ groupings: drawnBoard?.groupings ?? [] });
  const groupBy = resolveGroupBy(input.requestedGroupBy, groupings, initiatives.length);
  const grouped = groupLanes(input, groupBy);
  const view = {
    folds,
    openedCellIds: input.openedCellIds,
    openedStackIds: input.openedStackIds,
    stackCandidates: drawnBoard?.stackCandidates ?? NO_CANDIDATES,
  };
  const topRows = arrangeLanes(grouped.topRows, view);
  const block = topRows.length === 0 ? null : { rows: topRows, isFolded: isBlockFolded(folds) };
  const lanes = grouped.groups.map(({ lane, rows }) => arrangeLane(lane, view, rows));
  const everyLane = [...topRows, ...lanes.flatMap((lane) => [lane, ...lane.rows])];
  const drawnLanes = [
    ...(block === null || block.isFolded ? [] : block.rows),
    ...lanes.flatMap((lane) => (lane.isFolded ? [lane] : [lane, ...lane.rows])),
  ];
  const lanesById = new Map(everyLane.map((each) => [each.lane.id, each]));
  const drawsInitiatives =
    initiatives.length > 0 && (groupBy === PROJECT_FACET_ID || groupBy === INITIATIVE_FACET_ID);
  return {
    groupBy,
    groupings,
    block,
    lanes,
    everyLane,
    drawnLanes,
    shownCards: listShownCards(drawnLanes),
    stageCounts: drawnBoard === undefined ? null : countCardsByStage(everyLane),
    factsByInitiativeId: new Map(
      everyLane.flatMap(({ lane: { initiative } }) =>
        initiative?.isRow === true && logicalBoard !== undefined
          ? [
              [
                initiative.initiativeId,
                describeInitiativeFacts(
                  computeInitiativeProgress(logicalBoard, initiative.initiativeId),
                  initiative.projectName,
                ),
              ] as const,
            ]
          : [],
      ),
    ),
    isEmpty: drawnBoard !== undefined && drawnBoard.cards.length === 0 && !drawsInitiatives,
    findLane: (laneId) => lanesById.get(laneId),
  };
};
