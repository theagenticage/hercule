/** Test cards for the Work board, in the invented Northwind Market world. */
import type { EntityPlace, WorkBoard, WorkCard } from "@hercule/contract";

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
  entityMarks: [],
  contextRefs: [],
  ...overrides,
});

/** Returns a board of these cards, in this order, with no outside places. */
export const buildBoard = (...cards: readonly WorkCard[]): WorkBoard => ({
  cards,
  truncated: false,
  places: [],
  edges: [],
  groupings: [],
  contextComplete: true,
});

/**
 * Returns a place of the invented `acme/project` kind, a groupable kind with
 * the noun "Project" and the caption "Acme project". `overrides` change any field.
 */
export const buildPlace = (
  ref: string,
  title: string,
  overrides: Partial<EntityPlace> = {},
): EntityPlace => ({
  ref,
  kind: "acme/project",
  noun: "Project",
  caption: "Acme project",
  title,
  restricted: false,
  ...overrides,
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
