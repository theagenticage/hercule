import { BOARD_STAGES, type BoardStage, type WorkCard } from "@hercule/contract";

/** Returns how many of `cards` stand at each stage, with 0 for a stage no card is at. */
export const countCardsByStage = (
  cards: readonly WorkCard[],
): Readonly<Record<BoardStage, number>> => {
  const counts = Object.fromEntries(BOARD_STAGES.map((stage) => [stage, 0])) as Record<
    BoardStage,
    number
  >;
  for (const card of cards) counts[card.stage] += 1;
  return counts;
};
