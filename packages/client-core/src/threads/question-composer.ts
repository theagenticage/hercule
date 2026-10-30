/**
 * Answering a `question` Request in the composer. When the shown Request is a
 * question, the composer edits the shown question's own answer instead of the
 * user's message, and its send button becomes a step button: Next, or Send
 * answers on the last question. Both apps decide that here, so they cannot
 * disagree about when the composer answers, when the step button works, or
 * what it does.
 */
import {
  MAX_ANSWERS_LENGTH,
  MAX_MESSAGE_LENGTH,
  isAsyncQuestion,
  type QuestionAnswers,
  type SessionRequest,
} from "@hercule/contract";
import { buildApprovalCard, type ApprovalQuestion } from "./approval";
import {
  buildAnswerValue,
  buildQuestionAnswers,
  buildQuestionDraft,
  isQuestionAnswered,
  typeQuestionAnswer,
  type QuestionDraft,
} from "./question-draft";
import type { RequestDraft } from "./request-drafts";

/** How long the user must stop typing in the composer before a question takes it over, in milliseconds. */
export const TYPING_PAUSE_MS = 1500;

/** The label of the button that shows the question before the shown one. */
export const PREVIOUS_QUESTION_LABEL = "Previous";

/** The label of the step button on every question but the last. */
export const NEXT_QUESTION_LABEL = "Next";

/** The label of the step button on the last question, which sends the answers. */
export const SEND_ANSWERS_LABEL = "Send answers";

/** The label of the button that unfolds a folded async question. */
export const UNFOLD_QUESTION_LABEL = "Answer";

/** The label of the button that folds an unfolded async question back into one row. */
export const FOLD_QUESTION_LABEL = "Later";

/** The reason the Attach button is off while the composer answers a question. */
export const ANSWER_ATTACH_OFF_REASON = "An answer takes text only";

/** The notice shown when the user pastes or drops a file while the composer answers a question. */
export const REFUSED_FILE_NOTICE = "An answer takes text only. Images can be sent in a message.";

/** The question the composer answers, with the Request it belongs to and where its draft stands. */
export interface ComposerQuestion {
  readonly requestId: string;
  /** Every question of the Request, in order. */
  readonly questions: readonly ApprovalQuestion[];
  /** The shown question, which is `questions[draft.shownQuestionIndex]`. */
  readonly question: ApprovalQuestion;
  /**
   * Names the shown question's answer across Requests, such as the key of its
   * undo history and of a refused file's notice.
   */
  readonly answerKey: string;
  /** The shown question's own answer typed so far; empty when the user typed nothing. */
  readonly text: string;
  /** Whether the answers are sent: nothing takes input until the controller closes the Request. */
  readonly locked: boolean;
  /** Why the last send failed, or `null`. */
  readonly failure: string | null;
  /** The step controls for the shown question. */
  readonly stepper: QuestionStepper;
}

/**
 * Returns the question the composer answers, or `null` when the composer stays
 * a message composer. The composer answers when all of these hold:
 *
 * - `request` is a `question` Request;
 * - the Request is blocking, or it is async and `draft.unfolded`;
 * - the shown question is not secret. A secret question is answered in a
 *   masked field in the dock, because the composer's text would show in the
 *   clear.
 *
 * `draft` is the draft of `request`. A Request whose answers are already sent
 * still returns its question, with `locked` set, so the composer stays locked
 * on it until the controller closes the Request.
 */
export const findComposerQuestion = (
  request: SessionRequest | null,
  draft: RequestDraft,
): ComposerQuestion | null => {
  if (request === null || request.kind !== "question") return null;
  if (isAsyncQuestion(request) && !draft.unfolded) return null;
  const questions = buildApprovalCard(request).questions;
  const question = questions[draft.shownQuestionIndex];
  if (question === undefined || question.secretWarning !== null) return null;
  const status = buildQuestionStatus(draft, questions);
  return {
    requestId: request.requestId,
    questions,
    question,
    answerKey: `${request.requestId}:${question.header}`,
    text: status.questionDraft[question.header]!.text,
    locked: draft.answered,
    failure: draft.failure,
    stepper: buildStepper(status),
  };
};

/**
 * Returns `draft` with `text` typed as the user's own answer to its shown
 * question, out of `questions` (the Request's, in order). A draft the user has
 * not touched yet starts from an empty answer to every question.
 */
export const typeShownQuestionAnswer = (
  draft: RequestDraft,
  questions: readonly ApprovalQuestion[],
  text: string,
): RequestDraft => ({
  ...draft,
  question: typeQuestionAnswer(
    draft.question ?? buildQuestionDraft(questions),
    questions[draft.shownQuestionIndex]!,
    text,
  ),
});

/** What the step button and the controls around it show and allow. */
export interface QuestionStepper {
  /** The label of the step button. */
  readonly stepLabel: typeof NEXT_QUESTION_LABEL | typeof SEND_ANSWERS_LABEL;
  /** Whether to draw the Previous button: from the second question on. */
  readonly showsPrevious: boolean;
  /** Whether Previous works. */
  readonly canGoBack: boolean;
  /** Whether the step button works, which is whether `decideQuestionStep` allows "next". */
  readonly ready: boolean;
  /** The placeholder of the field that takes the shown question's own answer. */
  readonly placeholder: string;
  /** Why the step button is off because of a length limit, or `null` when no limit is exceeded. */
  readonly notice: string | null;
}

/** The longest an answer may be, as the text of a notice: "4,096". */
const MAX_ANSWER_TEXT = MAX_MESSAGE_LENGTH.toLocaleString("en-US");

/** The longest all answers of a Request may be together, as the text of a notice: "16,384". */
const MAX_ANSWERS_TEXT = MAX_ANSWERS_LENGTH.toLocaleString("en-US");

const ANSWER_TOO_LONG = `This answer is longer than ${MAX_ANSWER_TEXT} characters.`;

const ANSWERS_TOO_LONG = `These answers are longer than ${MAX_ANSWERS_TEXT} characters together.`;

/** Counts the characters of one answer value the way the protocol counts them. */
const countValueCharacters = (value: string | readonly string[] | null): number => {
  if (value === null) return 0;
  return typeof value === "string"
    ? value.length
    : value.reduce((total, item) => total + item.length, 0);
};

/** Where the draft stands on the shown question, as `buildQuestionStatus` builds it. */
interface QuestionStatus {
  readonly index: number;
  readonly isLast: boolean;
  readonly question: ApprovalQuestion;
  /** The draft of every question; the empty draft when the user touched nothing. */
  readonly questionDraft: QuestionDraft;
  readonly canGoBack: boolean;
  /** Whether "next" is allowed, by the rule `decideQuestionStep` states. */
  readonly isReady: boolean;
  /** The notice for the limit that is exceeded, or `null`. */
  readonly lengthNotice: string | null;
}

/**
 * Builds where `draft` stands on its shown question, the one place that
 * decides readiness for the stepper and for `decideQuestionStep`. The length
 * of all answers is computed from the values that would be sent (picks and
 * trimmed typed text, plus every header, as the protocol counts), so it is
 * right while other questions are still unanswered. Unanswered questions
 * count their header only, so the total never shrinks as the user answers on.
 */
const buildQuestionStatus = (
  draft: RequestDraft,
  questions: readonly ApprovalQuestion[],
): QuestionStatus => {
  const index = draft.shownQuestionIndex;
  const question = questions[index]!;
  const questionDraft = draft.question ?? buildQuestionDraft(questions);
  const answersLength = questions.reduce(
    (total, each) =>
      total + each.header.length + countValueCharacters(buildAnswerValue(questionDraft, each)),
    0,
  );
  const lengthNotice =
    questionDraft[question.header]!.text.trim().length > MAX_MESSAGE_LENGTH
      ? ANSWER_TOO_LONG
      : answersLength > MAX_ANSWERS_LENGTH
        ? ANSWERS_TOO_LONG
        : null;
  const isLast = index === questions.length - 1;
  const isAnswered = isLast
    ? buildQuestionAnswers(questionDraft, questions) !== null
    : isQuestionAnswered(questionDraft, question);
  return {
    index,
    isLast,
    question,
    questionDraft,
    canGoBack: index > 0 && !draft.answered,
    isReady: !draft.answered && isAnswered && lengthNotice === null,
    lengthNotice,
  };
};

/** Builds the state of the step controls from where the draft stands. */
const buildStepper = (status: QuestionStatus): QuestionStepper => ({
  stepLabel: status.isLast ? SEND_ANSWERS_LABEL : NEXT_QUESTION_LABEL,
  showsPrevious: status.index > 0,
  canGoBack: status.canGoBack,
  ready: status.isReady,
  placeholder: status.question.options.length > 0 ? "Or type your own answer" : "Type your answer",
  notice: status.lengthNotice,
});

/**
 * Builds the state of the step controls for the question `draft` shows, out
 * of `questions` (the Request's, in order). `findComposerQuestion` carries
 * the same state for the composer; the dock's own field calls this.
 */
export const buildQuestionStepper = (
  draft: RequestDraft,
  questions: readonly ApprovalQuestion[],
): QuestionStepper => buildStepper(buildQuestionStatus(draft, questions));

/** What a step does: show another question, or send the answers. */
export type QuestionStep =
  | { readonly kind: "show"; readonly index: number }
  | { readonly kind: "send"; readonly answers: QuestionAnswers };

/**
 * Returns what stepping `direction` from the question `draft` shows should
 * do, or `null` when the step is not allowed. This is the one statement of
 * the rule; the stepper's `ready` and `canGoBack` report its result.
 *
 * - `"previous"` shows the question before. It is allowed unless this is the
 *   first question or the answers are sent. A blank or over-long answer does
 *   not stop it.
 * - `"next"` shows the question after, or on the last question sends the
 *   answers `buildQuestionAnswers` builds from the draft. It is allowed
 *   when the answers are not sent, the shown question is answered, and no
 *   length limit is exceeded. On the last question every question must be
 *   answered, because the controller refuses answers that leave one out.
 */
export const decideQuestionStep = (
  draft: RequestDraft,
  questions: readonly ApprovalQuestion[],
  direction: "previous" | "next",
): QuestionStep | null => {
  const status = buildQuestionStatus(draft, questions);
  if (direction === "previous") {
    return status.canGoBack ? { kind: "show", index: status.index - 1 } : null;
  }
  if (!status.isReady) return null;
  if (!status.isLast) return { kind: "show", index: status.index + 1 };
  const answers = buildQuestionAnswers(status.questionDraft, questions);
  return answers === null ? null : { kind: "send", answers };
};

/**
 * Describes a folded async question as the one row the dock shows: that the
 * agent asked, and that it keeps working.
 */
export const describeFoldedQuestion = (
  request: Extract<SessionRequest, { readonly kind: "question" }>,
): string => {
  const count = request.detail.questions.length;
  return `The agent asked ${count === 1 ? "a question" : `${String(count)} questions`}. It keeps working.`;
};
