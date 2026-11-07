/**
 * The lanes of the Work board as the screen draws them: what each cell shows
 * under the user's folds and opened cells, and the counts and dots the heads
 * of the lanes show. Everything that asks what is on screen (the keyboard
 * walk, a drop, the counts over the stages) reads these, so none of them can
 * disagree about it.
 */
import {
  BOARD_STAGES,
  type BoardStage,
  type WorkCard,
  type WorkStackCandidate,
} from "@hercule/contract";
import { arrangeCell, type ArrangedCell } from "./arrange-cell";
import type { WorkLane } from "./lanes";

/** The dot a folded lane shows under a stage: a card in it failed, or has a question. */
type CellDot = "failed" | "question";

/** One cell of a lane: what it shows, and whether the user opened it. */
export interface ArrangedLaneCell {
  readonly stage: BoardStage;
  readonly cellId: string;
  readonly arrangement: ArrangedCell;
  /**
   * The ids of the lead cards whose stack is open, so its members are drawn:
   * the user opened the stack, or a member has a question or a failure.
   * Only leads that `arrangement.cards` draws are in it.
   */
  readonly openStackLeadIds: ReadonlySet<string>;
  /**
   * Every card the cell draws, top to bottom: each card of
   * `arrangement.cards`, followed by the members of its stack when that stack
   * is open. The keyboard walks these, and the selection keeps only these.
   */
  readonly shownCards: readonly WorkCard[];
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
  /** The ids (`buildStackId`) of the stacks the user opened. */
  readonly openedStackIds: ReadonlySet<string>;
  /** The pairs of Tasks a stack may join, as `WorkBoard.stackCandidates` holds them. */
  readonly stackCandidates: readonly WorkStackCandidate[];
  readonly isFiltering: boolean;
}

/** Returns the id of one cell of the board, the key `openedCellIds` holds. */
export const buildCellId = (laneId: string, stage: BoardStage): string => `${laneId}/${stage}`;

/**
 * Returns the id of the stack that the card `leadId` leads in the lane
 * `laneId`, the key `openedStackIds` holds. A Task under two outside places
 * leads a stack in each lane, and the user opens each on its own.
 */
export const buildStackId = (laneId: string, leadId: string): string => `${laneId}/${leadId}`;

/**
 * Returns the leads of `arrangement` that draw their members: the stack was
 * opened by the user, or it opens itself.
 */
const listOpenStackLeadIds = (
  laneId: string,
  arrangement: ArrangedCell,
  openedStackIds: ReadonlySet<string>,
): ReadonlySet<string> =>
  new Set(
    arrangement.cards
      .filter((card) => {
        const stack = arrangement.stacks.get(card.id);
        return (
          stack !== undefined &&
          (stack.opensItself || openedStackIds.has(buildStackId(laneId, card.id)))
        );
      })
      .map((card) => card.id),
  );

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
      const arrangement = arrangeCell(
        cell.cards,
        {
          stage: cell.stage,
          opened: view.openedCellIds.has(cellId),
          filtered: view.isFiltering,
        },
        view.stackCandidates,
      );
      const openStackLeadIds = listOpenStackLeadIds(lane.id, arrangement, view.openedStackIds);
      return {
        stage: cell.stage,
        cellId,
        arrangement,
        openStackLeadIds,
        shownCards: arrangement.cards.flatMap((card) =>
          openStackLeadIds.has(card.id)
            ? [card, ...(arrangement.stacks.get(card.id)?.members ?? [])]
            : [card],
        ),
        cardCount: cell.cards.length,
        dot: chooseCellDot(cell.cards),
      };
    }),
  }));

/**
 * Returns how many Tasks stand at each stage across `lanes`, shown or not,
 * with 0 for a stage no Task is at. A Task with a card in two lanes (under two
 * outside places) is counted once.
 */
export const countCardsByStage = (
  lanes: readonly ArrangedLane[],
): Readonly<Record<BoardStage, number>> => {
  const taskIds = new Map<BoardStage, Set<string>>(BOARD_STAGES.map((stage) => [stage, new Set()]));
  for (const { lane } of lanes) {
    for (const { stage, cards } of lane.cells) {
      for (const card of cards) taskIds.get(stage)?.add(card.id);
    }
  }
  return Object.fromEntries(
    BOARD_STAGES.map((stage) => [stage, taskIds.get(stage)?.size ?? 0]),
  ) as Record<BoardStage, number>;
};
