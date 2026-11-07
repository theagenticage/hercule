/**
 * The words a card carries: the stage names, the line that says a run failed,
 * the second line a card shows, and the name a screen reader reads for a card.
 */
import type { BoardStage, WorkCard } from "@hercule/contract";
import { describeDeskAge } from "../desk/age";

/** The name of each stage as the board shows it. */
export const STAGE_NAMES: Readonly<Record<BoardStage, string>> = {
  exploring: "Exploring",
  planned: "Planned",
  building: "Building",
  "in-review": "In review",
  landed: "Landed",
};

/**
 * Returns the cause on one line, without a closing full stop (the line adds
 * its own), or `undefined` when nothing is left.
 */
const cleanCause = (cause: string): string | undefined =>
  cause.replace(/\s+/g, " ").trim().replace(/\.+$/, "") || undefined;

/**
 * Returns the line a failed card shows: "Review PR failed: the branch changed
 * mid-run." with a cause, and "Review PR failed." without one. A cause that
 * spans several lines is joined into one.
 */
export const describeCardFailure = (failure: NonNullable<WorkCard["failure"]>): string => {
  const cause = cleanCause(failure.cause);
  return `${failure.workflowName} failed${cause === undefined ? "" : `: ${cause}`}.`;
};

/**
 * Returns the words a card shows for its open question: the question itself,
 * or "Has a question" when the agent asked an empty one or one of only
 * whitespace.
 */
export const describeCardQuestion = (question: NonNullable<WorkCard["openQuestion"]>): string =>
  question.text.trim() === "" ? "Has a question" : question.text;

/** The line under a card's title, and how it reads: what broke, or what a Thread asks. */
export interface CardSecondLine {
  readonly text: string;
  readonly tone: "failed" | "question";
}

/**
 * Returns the second line of `card`, or `null` when the card has none. A
 * failure outranks a question, as it does everywhere on a card.
 */
export const chooseCardSecondLine = (card: WorkCard): CardSecondLine | null => {
  if (card.failure !== undefined) {
    return { text: describeCardFailure(card.failure), tone: "failed" };
  }
  if (card.openQuestion !== undefined) {
    return { text: describeCardQuestion(card.openQuestion), tone: "question" };
  }
  return null;
};

/**
 * Returns the name a screen reader reads for a card, in this order: the
 * title, what broke, what it asks, the stage, the age. What broke comes
 * before what it asks because a failure outranks everything else on a card.
 * `now` is a parameter so a test can fix it.
 */
export const describeCardForReader = (card: WorkCard, now: Date): string => {
  const failure = card.failure === undefined ? [] : [describeCardFailure(card.failure)];
  const question = card.openQuestion === undefined ? [] : [describeCardQuestion(card.openQuestion)];
  return [
    card.title,
    ...failure,
    ...question,
    STAGE_NAMES[card.stage],
    describeDeskAge(card.lastActivityAt, now),
  ].join(", ");
};
