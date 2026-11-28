/**
 * One lane of the Work board as the screen draws it: what each cell shows
 * under the user's folds and opened cells, and the counts and dots the head
 * of the lane shows. `arrangeBoard` arranges all the lanes of the board; this
 * file arranges one.
 */
import {
  BOARD_STAGES,
  type BoardStage,
  type WorkCard,
  type WorkStackCandidate,
} from "@hercule/contract";
import { arrangeCell, type ArrangedCell } from "./arrange-cell";
import { isFolded, type BoardFolds } from "./board-folds";
import { buildInitiativeLine, type InitiativeLine } from "./initiative-line";
import type { HeldInitiative, WorkLane } from "./lanes";

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
  /**
   * How many cards the lane stands for at this stage: the cell's own, and
   * those on the Initiative rows under the lane (`ArrangedLane.rows`). A folded
   * lane shows this count. It equals `cardCount` for any lane with no row
   * under it, and for every row.
   */
  readonly cardCountWithRows: number;
  /**
   * The dot a folded lane shows under this stage, or `null` for none. It reads
   * the cell's cards and the cards of the rows under the lane.
   */
  readonly dot: CellDot | null;
}

/** One lane as the board draws it. */
export interface ArrangedLane {
  readonly lane: WorkLane;
  readonly isFolded: boolean;
  /**
   * How many cards of the lane failed, in any stage, counting the cards of its
   * rows. The head says "1 failed" when it is above 0, folded or not.
   */
  readonly failedCount: number;
  /** How many cards the lane stands for, in any stage, counting its rows. The head shows it next to the name. */
  readonly cardCountWithRows: number;
  /**
   * The Initiative rows drawn under the lane (Group by Project, In lanes), each
   * arranged. Empty for a row and for every lane that has none. A folded lane
   * does not draw them.
   */
  readonly rows: readonly ArrangedLane[];
  /**
   * The small flag of each row under the lane, in the order of the rows. A
   * folded lane hides its rows and keeps a flag for each in its head.
   */
  readonly heldInitiatives: readonly HeldInitiative[];
  /** The five cells. A folded lane draws counts instead, and its cells show no card. */
  readonly cells: readonly ArrangedLaneCell[];
  /**
   * The beads of an Initiative row, folded or not (a row opens in place into
   * its cells, and its beads stay for the user to fold it again). Absent for
   * any lane that is not a row.
   */
  readonly line?: InitiativeLine;
}

/** How the user looks at the lanes. */
interface LaneView {
  readonly folds: BoardFolds;
  readonly openedCellIds: ReadonlySet<string>;
  /** The ids (`buildStackId`) of the stacks the user opened. */
  readonly openedStackIds: ReadonlySet<string>;
  /** The pairs of Tasks a stack may join, as `WorkBoard.stackCandidates` holds them. */
  readonly stackCandidates: readonly WorkStackCandidate[];
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

/** Returns `candidates` grouped by the Task that would lead the stack, each group in board order. */
const groupCandidatesByLead = (
  candidates: readonly WorkStackCandidate[],
): ReadonlyMap<string, readonly WorkStackCandidate[]> => {
  const byLead = new Map<string, WorkStackCandidate[]>();
  for (const candidate of candidates) {
    const group = byLead.get(candidate.leadTaskId) ?? [];
    group.push(candidate);
    byLead.set(candidate.leadTaskId, group);
  }
  return byLead;
};

/**
 * Returns `lane` as the board draws it under `view`. `rows` are the Initiative
 * rows drawn under the lane (In lanes); the lane's head, counts and dots stand
 * for them too, though the rows draw their own cards. A row's own `rows` is
 * always empty.
 */
export const arrangeLane = (
  lane: WorkLane,
  view: LaneView,
  rows: readonly WorkLane[] = [],
): ArrangedLane => {
  const candidatesByLead = groupCandidatesByLead(view.stackCandidates);
  const cardsWithRows = lane.cells.map(({ stage, cards }) => [
    ...cards,
    ...rows.flatMap((row) => row.cells.find((cell) => cell.stage === stage)?.cards ?? []),
  ]);
  return {
    lane,
    isFolded: isFolded(view.folds, lane),
    ...(lane.initiative?.isRow === true
      ? { line: buildInitiativeLine(lane.cells, lane.initiative.doneRingCount) }
      : {}),
    failedCount: cardsWithRows.reduce(
      (total, cards) => total + cards.filter((card) => card.failure !== undefined).length,
      0,
    ),
    cardCountWithRows: cardsWithRows.reduce((total, cards) => total + cards.length, 0),
    rows: rows.map((row) => arrangeLane(row, view)),
    heldInitiatives: rows.flatMap(({ name, initiative }): HeldInitiative[] =>
      initiative?.isRow === true
        ? [{ id: initiative.initiativeId, hue: initiative.hue, name }]
        : [],
    ),
    cells: lane.cells.map((cell, index) => {
      const cellId = buildCellId(lane.id, cell.stage);
      const arrangement = arrangeCell(
        cell.cards,
        {
          stage: cell.stage,
          opened: view.openedCellIds.has(cellId),
          filtered: view.folds.isFiltering,
        },
        cell.cards.flatMap((card) => candidatesByLead.get(card.id) ?? []),
      );
      const openStackLeadIds = listOpenStackLeadIds(lane.id, arrangement, view.openedStackIds);
      const withRows = cardsWithRows[index] ?? cell.cards;
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
        cardCountWithRows: withRows.length,
        dot: chooseCellDot(withRows),
      };
    }),
  };
};

/** Returns each of `lanes`, which have no Initiative rows under them, arranged under `view`. */
export const arrangeLanes = (lanes: readonly WorkLane[], view: LaneView): readonly ArrangedLane[] =>
  lanes.map((lane) => arrangeLane(lane, view));

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
