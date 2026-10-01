/**
 * Checks an answer to the request a session is parked on against that
 * request, before anything reaches the runner. An answer the harness cannot
 * use would be replaced or dropped there without the user knowing, so every
 * mismatch is refused here instead.
 */
import * as Effect from "effect/Effect";
import type { OpenRequest, QuestionAnswers, RequestResponse } from "@hercule/protocol";
import {
  createValidationError,
  type Issue,
  type SessionRespondInput,
  type Validation,
} from "@hercule/contract";

type Question = Extract<OpenRequest, { readonly kind: "question" }>["detail"]["questions"][number];

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
 * Checks that exactly one of `decision` and `answers` is given and that it
 * fits `open`, and returns it as the response to send. Fails with a
 * `Validation` error naming the field when:
 *
 * - both or neither are given;
 * - the decision is not one the request offers;
 * - answers are given to an approval;
 * - the answers name a header the question request does not have, leave a
 *   question out, or give several answers to a question that takes one.
 */
export const validateResponse = (
  open: OpenRequest,
  given: Omit<SessionRespondInput, "requestId">,
): Effect.Effect<RequestResponse, Validation> => {
  const { decision, answers } = given;
  if (decision !== undefined && answers === undefined) {
    return open.decisions.includes(decision)
      ? Effect.succeed({ decision })
      : Effect.fail(
          createValidationError([
            {
              path: ["decision"],
              message: `that request accepts only ${open.decisions.join(", ")}`,
            },
          ]),
        );
  }
  if (answers === undefined || decision !== undefined) {
    return Effect.fail(
      createValidationError([
        { path: ["decision"], message: "give either a decision or answers, not both or neither" },
      ]),
    );
  }
  if (open.kind !== "question") {
    return Effect.fail(
      createValidationError([
        {
          path: ["answers"],
          message: "only a question takes answers; this request takes a decision",
        },
      ]),
    );
  }
  const issues = listAnswerIssues(open.detail.questions, answers);
  return issues.length === 0
    ? Effect.succeed({ answers })
    : Effect.fail(createValidationError(issues));
};
