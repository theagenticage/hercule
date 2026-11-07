/**
 * How the details pane answers a question. The pane answers one narrow case
 * by itself: a Request with one question, one choice, not secret. Every other
 * question shows its words and leads to the Thread, whose composer answers
 * all kinds well. The answers are built with the composer's own question
 * draft, so the pane and the composer agree on what counts as an answer.
 */
import type { QuestionAnswers, TaskDetail } from "@hercule/contract";
import type { ApprovalQuestion } from "../threads/approval";
import {
  buildQuestionStepper,
  decideQuestionStep,
  type QuestionStep,
} from "../threads/question-composer";
import {
  buildQuestionDraft,
  pickQuestionOption,
  typeQuestionAnswer,
} from "../threads/question-draft";
import { EMPTY_REQUEST_DRAFT } from "../threads/request-drafts";

/** What the pane reads of a Task to find its question. */
export type TaskQuestionSource = Pick<TaskDetail, "card" | "sessions">;

/** One answer the Request offers, drawn as a chip. */
export interface QuestionChip {
  readonly label: string;
  /** What choosing the chip means; absent when the agent wrote none. */
  readonly description?: string;
  /** True for the first chip, which the pane fills and Return sends. */
  readonly suggested: boolean;
}

/** The question every shape of `TaskQuestion` carries. */
interface TaskQuestionWords {
  /** The Thread that asks. The answer goes to this Thread, and Open thread opens it. */
  readonly sessionId: string;
  readonly requestId: string;
  /**
   * The name of who asks, when the Thread's own agent is not the one: the
   * subagent that asked, else the Thread's role. `null` for a Thread that has
   * no role, which the pane words "A Thread asks."
   */
  readonly asker: string | null;
  /** The first question, in the agent's own words. */
  readonly question: string;
}

/** A question the pane answers: a chip, or a line of the user's own words. */
export interface AnswerableTaskQuestion extends TaskQuestionWords {
  readonly kind: "answerable";
  /** The question's short header, which keys its answer. */
  readonly header: string;
  /** The Request's own options, in its order. Empty when the agent offered none. */
  readonly chips: readonly QuestionChip[];
  /** What the line for the user's own words shows before they type. */
  readonly placeholder: string;
}

/** A question the pane only shows. The user answers it in the Thread. */
export interface OpenThreadTaskQuestion extends TaskQuestionWords {
  readonly kind: "open-thread";
}

export type TaskQuestion = AnswerableTaskQuestion | OpenThreadTaskQuestion;

/** The words shown for a question the agent asked with no text. */
const BLANK_QUESTION = "Has a question";

/**
 * Finds the question the pane shows for `detail`, or returns `null` when
 * there is none. There is none when:
 *
 * - the card names no open question;
 * - the named Request is not among the open Requests of the Task's Threads
 *   that were read, because it closed, or the Thread is not among the ten the
 *   detail lists;
 * - the Request is an approval. The pane never offers one.
 *
 * A Request with one question, a single choice, not marked secret is
 * `answerable`. A Request with several questions, a `multiSelect` question or
 * a secret one is `open-thread`, with the words of its first question.
 */
export const decideQuestionAnswers = (detail: TaskQuestionSource): TaskQuestion | null => {
  const asked = detail.card.openQuestion;
  if (asked === undefined) return null;
  const session = detail.sessions.find((each) => each.id === asked.sessionId);
  const request = session?.openRequests.find((each) => each.requestId === asked.requestId);
  if (session === undefined || request === undefined || request.kind !== "question") return null;

  const first = request.detail.questions[0];
  const words: TaskQuestionWords = {
    sessionId: session.id,
    requestId: request.requestId,
    asker: request.subagentName ?? (session.role?.trim() || null),
    question: first.question.trim() === "" ? BLANK_QUESTION : first.question,
  };
  const answerable =
    request.detail.questions.length === 1 && !first.multiSelect && first.secret !== true;
  if (!answerable) return { kind: "open-thread", ...words };
  return {
    kind: "answerable",
    ...words,
    header: first.header,
    chips: first.options.map((option, index) => ({
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
      suggested: index === 0,
    })),
    placeholder: first.options.length > 0 ? "Or say something else…" : "Type your answer",
  };
};

/** What the user gave: one of the chips, or their own words. */
export type PaneAnswer =
  | { readonly kind: "chip"; readonly label: string }
  | { readonly kind: "text"; readonly text: string };

/**
 * The result of building an answer: the `answers` of `session.respondToQuestion`
 * to send, or a refusal. `notice` says why, in words for the user, and is
 * `null` when the answer is only blank.
 */
export type PaneAnswerResult =
  | { readonly kind: "send"; readonly answers: QuestionAnswers }
  | { readonly kind: "refuse"; readonly notice: string | null };

/**
 * Rebuilds the question as the composer's question draft reads it. The
 * options carry no description: the draft never reads it.
 */
const buildApprovalQuestion = (question: AnswerableTaskQuestion): ApprovalQuestion => ({
  header: question.header,
  question: question.question,
  options: question.chips.map((chip) => ({ label: chip.label })),
  multiSelect: false,
  note: null,
  secretWarning: null,
});

/**
 * Builds the `answers` of `session.respondToQuestion` for the user's `answer`
 * to `question`, or refuses. It refuses blank text, and text longer than the
 * composer allows, with the composer's own notice.
 */
export const buildPaneAnswers = (
  question: AnswerableTaskQuestion,
  answer: PaneAnswer,
): PaneAnswerResult => {
  const approvalQuestion = buildApprovalQuestion(question);
  const empty = buildQuestionDraft([approvalQuestion]);
  const draft = {
    ...EMPTY_REQUEST_DRAFT,
    question:
      answer.kind === "chip"
        ? pickQuestionOption(empty, approvalQuestion, answer.label, "").question
        : typeQuestionAnswer(empty, approvalQuestion, answer.text),
  };
  const step: QuestionStep | null = decideQuestionStep(draft, [approvalQuestion], "next");
  if (step?.kind === "send") return { kind: "send", answers: step.answers };
  return { kind: "refuse", notice: buildQuestionStepper(draft, [approvalQuestion]).notice };
};
