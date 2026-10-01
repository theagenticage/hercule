/**
 * The question draft: what the user has picked and typed for each question
 * of a `question` request before the answers are sent. Both apps' docks hold
 * a draft in state and build the `answers` of `session.respondToQuestion` from it, so
 * the two apps agree on what counts as an answer.
 *
 * Every function returns a new draft rather than changing the one it gets,
 * so a dock can keep the draft in React state.
 */
import type { QuestionAnswers } from "@hercule/contract";
import type { ApprovalQuestion } from "./approval";

/** What the user has given so far for one question. */
export interface QuestionDraftAnswer {
  /** The labels of the picked options, in the question's option order. */
  readonly picks: readonly string[];
  /** The user's own answer, as typed, untrimmed. */
  readonly text: string;
}

/**
 * The draft of every question of one request, by header. A request's headers
 * are unique, and the draft holds an own property for each, so no header can
 * find an inherited property such as `constructor`.
 */
export type QuestionDraft = Readonly<Record<string, QuestionDraftAnswer>>;

/** Builds the draft of `questions` with nothing picked and nothing typed. */
export const buildQuestionDraft = (questions: readonly ApprovalQuestion[]): QuestionDraft =>
  Object.fromEntries(questions.map((question) => [question.header, { picks: [], text: "" }]));

/**
 * Returns `draft` with the option labelled `label` picked for `question`.
 *
 * - On a single-select question the pick replaces any earlier pick and clears
 *   the typed text, because the question takes one answer.
 * - On a multiSelect question the pick toggles, and the typed text stays,
 *   because it is one more answer beside the picks.
 */
export const pickQuestionOption = (
  draft: QuestionDraft,
  question: ApprovalQuestion,
  label: string,
): QuestionDraft => {
  const current = draft[question.header]!;
  if (!question.multiSelect) {
    return { ...draft, [question.header]: { picks: [label], text: "" } };
  }
  const picked = current.picks.includes(label);
  // Kept in option order, so the answers do not depend on the order of clicks.
  const picks = question.options
    .map((option) => option.label)
    .filter((optionLabel) =>
      optionLabel === label ? !picked : current.picks.includes(optionLabel),
    );
  return { ...draft, [question.header]: { picks, text: current.text } };
};

/**
 * Returns `draft` with `text` as the user's own answer to `question`. On a
 * single-select question the text replaces the pick, because the question
 * takes one answer.
 */
export const typeQuestionAnswer = (
  draft: QuestionDraft,
  question: ApprovalQuestion,
  text: string,
): QuestionDraft => {
  const picks = question.multiSelect ? draft[question.header]!.picks : [];
  return { ...draft, [question.header]: { picks, text } };
};

/** Checks whether `question` has a pick or typed text that is not blank. */
export const isQuestionAnswered = (draft: QuestionDraft, question: ApprovalQuestion): boolean => {
  const { picks, text } = draft[question.header]!;
  return picks.length > 0 || text.trim() !== "";
};

/**
 * Builds the `answers` of `session.respondToQuestion` from `draft`, or returns `null`
 * while any of `questions` is unanswered, because the controller refuses
 * answers that leave a question out.
 *
 * A single-select question is answered with one string: its pick or its
 * trimmed text. A multiSelect question is answered with a list: its picks in
 * option order, then its trimmed text when that is not blank.
 */
export const buildQuestionAnswers = (
  draft: QuestionDraft,
  questions: readonly ApprovalQuestion[],
): QuestionAnswers | null => {
  if (!questions.every((question) => isQuestionAnswered(draft, question))) return null;
  return Object.fromEntries(
    questions.map((question) => {
      const { picks, text } = draft[question.header]!;
      const typed = text.trim();
      const given = typed === "" ? picks : [...picks, typed];
      return [question.header, question.multiSelect ? given : given[0]!];
    }),
  ) as QuestionAnswers;
};
