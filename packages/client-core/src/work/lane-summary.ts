/**
 * What the head of a lane says about the lane: for a folded lane, one small
 * count under each stage, and for any lane, how many cards failed.
 */
import type { BoardStage } from "@hercule/contract";
import { isLoudCard } from "./arrange-cell";
import type { WorkLane } from "./lanes";

/** The small count under one stage of a folded lane. */
export interface StageCount {
  readonly stage: BoardStage;
  readonly count: number;
  /** Whether a card of the stage has a question or a failure, which shows as a dot. */
  readonly showsDot: boolean;
}

/** What a lane's head says. */
export interface LaneSummary {
  readonly stageCounts: readonly StageCount[];
  /** The number of failed cards in the lane. The head says "1 failed" when it is above 0, folded or not. */
  readonly failedCount: number;
}

/** Returns the counts a folded lane shows, and the failed count the head of any lane shows. */
export const summarizeLane = (lane: WorkLane): LaneSummary => ({
  stageCounts: lane.cells.map((cell) => ({
    stage: cell.stage,
    count: cell.cards.length,
    showsDot: cell.cards.some(isLoudCard),
  })),
  failedCount: lane.cells.reduce(
    (total, cell) => total + cell.cards.filter((card) => card.failure !== undefined).length,
    0,
  ),
});
