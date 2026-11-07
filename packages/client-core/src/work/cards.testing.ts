/** Test cards for the Work board, in the invented Northwind Market world. */
import type { WorkBoard, WorkCard } from "@hercule/contract";

/**
 * Returns a card of the given id and title at Exploring, in no Project, with
 * no question, no failure and no live session. `overrides` change any field.
 */
export const buildCard = (id: string, overrides: Partial<WorkCard> = {}): WorkCard => ({
  id,
  title: `Task ${id}`,
  stage: "exploring",
  priority: "normal",
  boardRank: id,
  threadCount: 1,
  createdAt: "2026-11-01T09:00:00.000Z",
  stageChangedAt: "2026-11-01T09:00:00.000Z",
  lastActivityAt: "2026-11-01T09:00:00.000Z",
  ...overrides,
});

/** Returns a board of these cards, in this order. */
export const buildBoard = (...cards: readonly WorkCard[]): WorkBoard => ({
  cards,
  truncated: false,
});

/** A failure for a card, from the invented "Review PR" workflow. */
export const FAILURE: NonNullable<WorkCard["failure"]> = {
  runId: "run-1",
  workflowName: "Review PR",
  cause: "the branch changed mid-run",
};

/** An open question for a card. */
export const QUESTION: NonNullable<WorkCard["openQuestion"]> = {
  sessionId: "session-1",
  requestId: "request-1",
  text: "Should refunds go back to the original card?",
};

/** Returns the ids of these cards, for a short comparison. */
export const listIds = (cards: readonly WorkCard[]): readonly string[] =>
  cards.map((card) => card.id);
