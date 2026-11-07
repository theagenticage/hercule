import {
  arrangeCell,
  chooseCellDot,
  summarizeLane,
  type ArrangedCell,
  type CellDot,
  type LaneSummary,
  type ShownBoard,
  type WorkLane,
} from "@hercule/client-core/work";
import type { BoardStage } from "@hercule/contract";
import { buildCellId } from "./use-work-view";

/** One cell of a lane that is open: what it shows, and whether the user opened it. */
export interface ArrangedLaneCell {
  readonly stage: BoardStage;
  readonly cellId: string;
  readonly arrangement: ArrangedCell;
  /** How many cards the cell holds, shown or not. */
  readonly cardCount: number;
  /** The dot a folded lane shows under this stage, or `null` for none. */
  readonly dot: CellDot | null;
}

/** One lane as the board draws it. */
export interface ArrangedLane {
  readonly lane: WorkLane;
  readonly isFolded: boolean;
  /** What the lane's head says: how many cards failed. */
  readonly summary: LaneSummary;
  /** The five cells. A folded lane draws counts instead, and its cells show no card. */
  readonly cells: readonly ArrangedLaneCell[];
}

/** How the user looks at the lanes, as `useWorkView` holds it. */
export interface LaneView {
  readonly foldedLaneIds: ReadonlySet<string>;
  readonly openedCellIds: ReadonlySet<string>;
  readonly isFiltering: boolean;
}

/** Returns each of `lanes` with what its cells show under `view`. */
export const arrangeLanes = (lanes: readonly WorkLane[], view: LaneView): readonly ArrangedLane[] =>
  lanes.map((lane) => ({
    lane,
    isFolded: view.foldedLaneIds.has(lane.id),
    summary: summarizeLane(lane),
    cells: lane.cells.map((cell) => {
      const cellId = buildCellId(lane.id, cell.stage);
      return {
        stage: cell.stage,
        cellId,
        arrangement: arrangeCell(cell.cards, {
          stage: cell.stage,
          opened: view.openedCellIds.has(cellId),
          filtered: view.isFiltering,
        }),
        cardCount: cell.cards.length,
        dot: chooseCellDot(cell.cards),
      };
    }),
  }));

/**
 * Returns what is on screen, by lane and stage, for the keyboard walk. A
 * folded lane shows no card. A card hidden behind "13 more" is not on screen
 * either.
 */
export const listShownCards = (arrangedLanes: readonly ArrangedLane[]): ShownBoard =>
  arrangedLanes.map(({ lane, isFolded, cells }) => ({
    id: lane.id,
    isFolded,
    columns: cells.map(({ arrangement: cell }) =>
      isFolded ? [] : cell.cards.map((card) => card.id),
    ),
  }));
