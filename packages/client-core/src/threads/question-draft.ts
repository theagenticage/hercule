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
 * Joins `moved` to the end of `messageText` without changing a character of
 * either. The separator is the newlines needed to leave exactly one blank
 * line between them, counting the newlines `messageText` already ends with:
 *
 * - `messageText` is blank (empty, or only whitespace): no separator, because
 *   there is no content to set the text apart from;
 * - it ends in no newline: "\n\n";
 * - it ends in one newline: "\n";
 * - it ends in two or more: no separator, because it already ends in a blank
 *   line.
 */
const appendAfterBlankLine = (messageText: string, moved: string): string => {
  if (messageText.trim() === "") return messageText + moved;
  const trailingNewlines = (/(?:\r?\n)*$/.exec(messageText)![0].match(/\n/g) ?? []).length;
  return messageText + "\n".repeat(Math.max(0, 2 - trailingNewlines)) + moved;
};

/**
 * Returns `draft` with the option labelled `label` picked for `question`, and
 * the text of the user's message after the pick.
 *
 * - On a single-select question the pick replaces any earlier pick and clears
 *   the typed text, because the question takes one answer. Typed text that is
 *   not blank is not lost: it moves to the end of `messageText`, after a
 *   blank line. The text moves exactly as typed (it is only trimmed to decide
 *   whether it is blank) and `messageText` keeps every character it had, so
 *   the move never edits what the user wrote.
 * - The exception is a secret question (`secretWarning` is set). Its typed
 *   text is erased and not moved, and `messageText` is returned unchanged,
 *   because the Message Draft is visible and may be saved or sent, and a
 *   secret must never land there.
 * - On a multiSelect question the pick toggles, and the typed text stays,
 *   because it is one more answer beside the picks. `messageText` is returned
 *   unchanged.
 */
export const pickQuestionOption = (
  draft: QuestionDraft,
  question: ApprovalQuestion,
  label: string,
  messageText: string,
): { readonly question: QuestionDraft; readonly messageText: string } => {
  const current = draft[question.header]!;
  if (!question.multiSelect) {
    const moves = question.secretWarning === null && current.text.trim() !== "";
    return {
      question: { ...draft, [question.header]: { picks: [label], text: "" } },
      messageText: moves ? appendAfterBlankLine(messageText, current.text) : messageText,
    };
  }
  const picked = current.picks.includes(label);
  // Kept in option order, so the answers do not depend on the order of clicks.
  const picks = question.options
    .map((option) => option.label)
    .filter((optionLabel) =>
      optionLabel === label ? !picked : current.picks.includes(optionLabel),
    );
  return { question: { ...draft, [question.header]: { picks, text: current.text } }, messageText };
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

/**
 * Builds what `draft` would send as the answer to `question`, or returns
 * `null` while the question is unanswered. A single-select question is
 * answered with one string: its pick or its trimmed text. A multiSelect
 * question is answered with a list: its picks in option order, then its
 * trimmed text when that is not blank.
 */
export const buildAnswerValue = (
  draft: QuestionDraft,
  question: ApprovalQuestion,
): string | readonly string[] | null => {
  const { picks, text } = draft[question.header]!;
  const typed = text.trim();
  const given = typed === "" ? picks : [...picks, typed];
  if (given.length === 0) return null;
  return question.multiSelect ? given : given[0]!;
};

/** Checks whether `question` has a pick or typed text that is not blank. */
export const isQuestionAnswered = (draft: QuestionDraft, question: ApprovalQuestion): boolean =>
  buildAnswerValue(draft, question) !== null;

/**
 * Builds the `answers` of `session.respondToQuestion` from `draft`, or returns `null`
 * while any of `questions` is unanswered, because the controller refuses
 * answers that leave a question out. Each answer is the one `buildAnswerValue`
 * builds.
 */
export const buildQuestionAnswers = (
  draft: QuestionDraft,
  questions: readonly ApprovalQuestion[],
): QuestionAnswers | null => {
  const values = questions.map((question) => buildAnswerValue(draft, question));
  if (values.includes(null)) return null;
  return Object.fromEntries(
    questions.map((question, index) => [question.header, values[index]]),
  ) as QuestionAnswers;
};
