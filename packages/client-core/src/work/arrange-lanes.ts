/**
 * The lanes of the Work board as the screen draws them: what each cell shows
 * under the user's folds and opened cells, and the counts and dots the heads
 * of the lanes show. Everything that asks what is on screen (the keyboard
 * walk, a drop, the counts over the stages) reads these, so none of them can
 * disagree about it.
 */
import { BOARD_STAGES, type BoardStage, type WorkCard } from "@hercule/contract";
import { arrangeCell, type ArrangedCell } from "./arrange-cell";
import type { WorkLane } from "./lanes";

/** The dot a folded lane shows under a stage: a card in it failed, or has a question. */
type CellDot = "failed" | "question";

/** One cell of a lane: what it shows, and whether the user opened it. */
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
  /** How many cards of the lane failed, in any stage. The head says "1 failed" when it is above 0, folded or not. */
  readonly failedCount: number;
  /** The five cells. A folded lane draws counts instead, and its cells show no card. */
  readonly cells: readonly ArrangedLaneCell[];
}

/** How the user looks at the lanes, as `useWorkView` holds it. */
interface LaneView {
  readonly foldedLaneIds: ReadonlySet<string>;
  readonly openedCellIds: ReadonlySet<string>;
  readonly isFiltering: boolean;
}

/** Returns the id of one cell of the board, the key `openedCellIds` holds. */
export const buildCellId = (laneId: string, stage: BoardStage): string => `${laneId}/${stage}`;

/**
 * Returns the dot for the cards of one cell of a folded lane: `failed` when
 * any card failed, else `question` when any has an open question, else `null`.
 * A failure outranks a question because it is the one thing the page marks in
 * a loud colour.
 */
const chooseCellDot = (cards: readonly WorkCard[]): CellDot | null => {
  if (cards.some((card) => card.failure !== undefined)) return "failed";
  return cards.some((card) => card.openQuestion !== undefined) ? "question" : null;
};

/** Returns each of `lanes` with what its cells show under `view`. */
export const arrangeLanes = (lanes: readonly WorkLane[], view: LaneView): readonly ArrangedLane[] =>
  lanes.map((lane) => ({
    lane,
    isFolded: view.foldedLaneIds.has(lane.id),
    failedCount: lane.cells.reduce(
      (total, cell) => total + cell.cards.filter((card) => card.failure !== undefined).length,
      0,
    ),
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

/** Returns how many cards stand at each stage across `lanes`, shown or not, with 0 for a stage no card is at. */
export const countCardsByStage = (
  lanes: readonly ArrangedLane[],
): Readonly<Record<BoardStage, number>> => {
  const counts = Object.fromEntries(BOARD_STAGES.map((stage) => [stage, 0])) as Record<
    BoardStage,
    number
  >;
  for (const { cells } of lanes) {
    for (const { stage, cardCount } of cells) counts[stage] += cardCount;
  }
  return counts;
};
