/**
 * Checks an answer to the request a session is parked on against that
 * request, before anything reaches the runner. An answer the harness cannot
 * use would be replaced or dropped there without the user knowing, so every
 * mismatch is refused here instead.
 */
import * as Effect from "effect/Effect";
import type { ApprovalDecision, OpenRequest, Question, QuestionAnswers } from "@hercule/protocol";
import { createValidationError, type Issue, type Validation } from "@hercule/contract";

/**
 * Lists what is wrong with `answers` to `questions`, one issue per header:
 * a header no question has, a question left unanswered, or several answers
 * to a question that takes one.
 */
const listAnswerIssues = (
  questions: ReadonlyArray<Question>,
  answers: QuestionAnswers,
): ReadonlyArray<Issue> => {
  const headers = new Set(questions.map((question) => question.header));
  const unknownHeaderIssues = Object.keys(answers)
    .filter((header) => !headers.has(header))
    .map((header) => ({
      path: ["answers", header],
      message: `the request has no question with the header ${header}`,
    }));
  const questionIssues = questions.flatMap((question) => {
    const path = ["answers", question.header];
    // An own-property check, because a header such as `constructor` would
    // otherwise find a property every object inherits.
    if (!Object.hasOwn(answers, question.header)) {
      return [{ path, message: "this question needs an answer" }];
    }
    const answer = answers[question.header]!;
    if (!question.multiSelect && typeof answer !== "string" && answer.length > 1) {
      return [{ path, message: "this question takes one answer" }];
    }
    return [];
  });
  return [...unknownHeaderIssues, ...questionIssues];
};

/**
 * Checks that `decision` is one the approval `open` offers. Fails with a
 * `Validation` error on `decision` when `open` is a question, which takes
 * answers and no decision, or when the approval does not offer `decision`.
 */
export const validateDecision = (
  open: OpenRequest,
  decision: ApprovalDecision,
): Effect.Effect<void, Validation> => {
  if (open.kind === "question") {
    return Effect.fail(
      createValidationError([
        {
          path: ["decision"],
          message:
            "that request is a question, which takes answers and no decision; " +
            "answer it with session.respondToQuestion, or stop the turn with session.interrupt",
        },
      ]),
    );
  }
  return open.decisions.includes(decision)
    ? Effect.void
    : Effect.fail(
        createValidationError([
          { path: ["decision"], message: `that request accepts only ${open.decisions.join(", ")}` },
        ]),
      );
};

/**
 * Checks that `answers` fit the question `open`. Fails with a `Validation`
 * error naming the field when:
 *
 * - `open` is an approval, which takes a decision and no answers;
 * - the answers name a header the question does not have, leave a question
 *   out, or give several answers to a question that takes one.
 */
export const validateAnswers = (
  open: OpenRequest,
  answers: QuestionAnswers,
): Effect.Effect<void, Validation> => {
  if (open.kind !== "question") {
    return Effect.fail(
      createValidationError([
        {
          path: ["answers"],
          message:
            "that request is an approval, which takes a decision and no answers; " +
            "decide it with session.respondToApprovalRequest",
        },
      ]),
    );
  }
  const issues = listAnswerIssues(open.detail.questions, answers);
  return issues.length === 0 ? Effect.void : Effect.fail(createValidationError(issues));
};
