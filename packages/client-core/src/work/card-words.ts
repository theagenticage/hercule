/**
 * The words a card carries: the stage names, the line that says a run failed,
 * the second line a card shows (what broke, what a Thread asks, or the
 * Task's summary), and the name a screen reader reads for a card.
 */
import type { BoardStage, WorkCard } from "@hercule/contract";
import { describeDeskAge } from "../desk/age";
import { dropClosingFullStops } from "../text";

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
  dropClosingFullStops(cause.replace(/\s+/g, " ").trim()) || undefined;

/**
 * Returns the line a failed card shows: "Review PR failed: the branch changed
 * mid-run." with a cause, and "Review PR failed." without one. A cause that
 * spans several lines is joined into one.
 */
const describeCardFailure = (failure: NonNullable<WorkCard["failure"]>): string => {
  const cause = cleanCause(failure.cause);
  return `${failure.workflowName} failed${cause === undefined ? "" : `: ${cause}`}.`;
};

/** The words shown for a question the agent asked with no text. */
export const BLANK_QUESTION_WORDS = "Has a question";

/**
 * Returns the words a card shows for its open question: the question itself,
 * or `BLANK_QUESTION_WORDS` when the agent asked an empty one or one of only
 * whitespace.
 */
const describeCardQuestion = (question: NonNullable<WorkCard["openQuestion"]>): string =>
  question.text.trim() === "" ? BLANK_QUESTION_WORDS : question.text;

/** The words a card, and the details pane's note, show while the Task has no summary yet. */
export const PENDING_SUMMARY_WORDS = "Writing a summary";

/** What a screen reader reads for a card whose summary is not written yet. */
const PENDING_SUMMARY_READING = "Summary being written";

/**
 * A card as the board draws it: the card as read, plus the words of the
 * answer the user gave to its question while that answer is held. Only
 * `showHeldAnswers` sets `heldAnswer`.
 */
export type ShownWorkCard = WorkCard & {
  /** What the user answered, as `You said: “Ship it”.`, until the controller accepts or refuses it. */
  readonly heldAnswer?: string;
};

/**
 * The line under a card's title, and how it reads:
 *
 * - `failed`: what broke.
 * - `question`: what a Thread asks.
 * - `summary`: the Task's summary line, or the words of the answer given to
 *   its question while that answer is held.
 * - `pending`: no summary has been written yet, and one is being written.
 */
export interface CardSecondLine {
  readonly text: string;
  readonly tone: "failed" | "question" | "summary" | "pending";
}

/**
 * Returns the second line of `card`, or `null` when the card has none. What
 * broke takes the line first, then what a Thread asks, then the answer the
 * user gave that is still held (`You said: “Ship it”.`), then the summary
 * line, then "Writing a summary" for a Task that has no summary yet. A summary draws
 * the same whether it is stale or not, and it is never shown beside a failure
 * or a question.
 *
 * `canWriteSummaries` says whether Text Generation can run. When it cannot, no
 * summary is coming, so a card with none has no second line rather than
 * promising one. A card has no second line either when its summary has a
 * blank line.
 */
export const chooseCardSecondLine = (
  card: ShownWorkCard,
  canWriteSummaries: boolean,
): CardSecondLine | null => {
  if (card.failure !== undefined) {
    return { text: describeCardFailure(card.failure), tone: "failed" };
  }
  if (card.openQuestion !== undefined) {
    return { text: describeCardQuestion(card.openQuestion), tone: "question" };
  }
  if (card.heldAnswer !== undefined) return { text: card.heldAnswer, tone: "summary" };
  if (card.summary === undefined) {
    return canWriteSummaries ? { text: PENDING_SUMMARY_WORDS, tone: "pending" } : null;
  }
  const line = card.summary.line.trim();
  return line === "" ? null : { text: line, tone: "summary" };
};

/**
 * Returns the name a screen reader reads for a card, in this order: the
 * title, what broke, what it asks, the stage, the summary, the age. What
 * broke comes before what it asks because a failure outranks everything else
 * on a card. The summary is read only where the card shows it: not beside a
 * failure or a question. A Task with no summary yet reads "Summary being
 * written", unless `canWriteSummaries` is false (see `chooseCardSecondLine`).
 * `now` is a parameter so a test can fix it.
 */
export const describeCardForReader = (
  card: ShownWorkCard,
  now: Date,
  canWriteSummaries: boolean,
): string => {
  const failure = card.failure === undefined ? [] : [describeCardFailure(card.failure)];
  const question = card.openQuestion === undefined ? [] : [describeCardQuestion(card.openQuestion)];
  const secondLine = chooseCardSecondLine(card, canWriteSummaries);
  const summary =
    secondLine?.tone === "pending"
      ? [PENDING_SUMMARY_READING]
      : secondLine?.tone === "summary"
        ? [secondLine.text]
        : [];
  return [
    card.title,
    ...failure,
    ...question,
    STAGE_NAMES[card.stage],
    ...summary,
    describeDeskAge(card.lastActivityAt, now),
  ].join(", ");
};
