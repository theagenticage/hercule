/**
 * The words a card carries: the stage names, the line that says a run failed,
 * and the name a screen reader reads for a card.
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

/** The failure of a card, in the parts a screen needs to style the name of the workflow. */
export interface FailureWords {
  readonly workflowName: string;
  /** What follows the name, such as " failed: the branch changed mid-run." */
  readonly outcome: string;
  /** The whole line, `workflowName` then `outcome`. */
  readonly text: string;
}

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
export const describeCardFailure = (failure: NonNullable<WorkCard["failure"]>): FailureWords => {
  const cause = cleanCause(failure.cause);
  const outcome = cause === undefined ? " failed." : ` failed: ${cause}.`;
  return {
    workflowName: failure.workflowName,
    outcome,
    text: `${failure.workflowName}${outcome}`,
  };
};

/**
 * Returns the name a screen reader reads for a card, in this order: the
 * title, what broke, what it asks, the stage, the age. What broke comes
 * before what it asks because a failure outranks everything else on a card.
 * `now` is a parameter so a test can fix it.
 */
export const describeCardForReader = (card: WorkCard, now: Date): string => {
  const failure = card.failure === undefined ? [] : [describeCardFailure(card.failure).text];
  const question = card.openQuestion === undefined ? [] : [card.openQuestion.text];
  return [
    card.title,
    ...failure,
    ...question,
    STAGE_NAMES[card.stage],
    describeDeskAge(card.lastActivityAt, now),
  ].join(", ");
};
