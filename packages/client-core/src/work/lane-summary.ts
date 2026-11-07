/**
 * What the head of a lane says about the lane (how many cards failed), and the
 * dot a folded lane shows under each stage.
 */
import type { WorkCard } from "@hercule/contract";
import type { WorkLane } from "./lanes";

/** What a lane's head says. */
export interface LaneSummary {
  /** The number of failed cards in the lane. The head says "1 failed" when it is above 0, folded or not. */
  readonly failedCount: number;
}

/** The dot a folded lane shows under a stage: a card in it failed, or has a question. */
export type CellDot = "failed" | "question";

/** Returns the failed count the head of a lane shows. */
export const summarizeLane = (lane: WorkLane): LaneSummary => ({
  failedCount: lane.cells.reduce(
    (total, cell) => total + cell.cards.filter((card) => card.failure !== undefined).length,
    0,
  ),
});

/**
 * Returns the dot for the cards of one cell of a folded lane: `failed` when
 * any card failed, else `question` when any has an open question, else `null`.
 * A failure outranks a question because it is the one thing the page marks in
 * a loud colour.
 */
export const chooseCellDot = (cards: readonly WorkCard[]): CellDot | null => {
  if (cards.some((card) => card.failure !== undefined)) return "failed";
  return cards.some((card) => card.openQuestion !== undefined) ? "question" : null;
};
