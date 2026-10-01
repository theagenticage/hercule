/**
 * Converts the question a harness parks a session on into the one shape every
 * surface renders, and converts the user's answers back into the vendor's
 * keys. It lives in one module for three reasons:
 *
 * - two adapters reading a vendor's questions into slightly different shapes
 *   would give a card whose content depends on the harness, and the
 *   normalized event stream exists so that no surface does (ADR 0007);
 * - the answers can be matched to the vendor's questions only by parsing them
 *   exactly as the request was built, so building and answering share one
 *   parser;
 * - the fallback in `buildQuestionRequest` is the difference between a request
 *   the user can deny and a frame the controller drops.
 *
 * Every field is read defensively. The input is whatever the vendor sent, and
 * one field of the wrong type would otherwise produce a frame the runner
 * drops. That loses the event and leaves the session parked with no way out.
 */
import type { OpenRequest, QuestionAnswers } from "@hercule/protocol";
import { truncateFact, truncateMessage } from "./text";

/** One question as the protocol carries it, mapped from the vendor's shape. */
type Question = Extract<OpenRequest, { readonly kind: "question" }>["detail"]["questions"][number];

/**
 * Parses the options of one question. The user picks from them, and the
 * description of each is part of the question: a user who reads only the
 * question text cannot see what an option means.
 *
 * Fields the protocol has no place for, such as the Claude SDK's `preview`,
 * are dropped. So is an option with no label or with no description string.
 */
const parseOptions = (given: unknown): ReadonlyArray<Question["options"][number]> => {
  if (!Array.isArray(given)) return [];
  return given.flatMap((one: unknown) => {
    if (typeof one !== "object" || one === null) return [];
    const { label, description } = one as {
      readonly label?: unknown;
      readonly description?: unknown;
    };
    if (typeof label !== "string" || label === "" || typeof description !== "string") return [];
    return [{ label: truncateFact(label), description: truncateMessage(description) }];
  });
};

/**
 * The vendor field that identifies a question in the vendor's answer: the
 * Claude SDK keys an answer by the question's full text, and Codex by the
 * question's id.
 */
type AnswerKeyField = "question" | "id";

/** One parsed question, with the vendor's key for its answer. */
interface KeyedQuestion {
  readonly question: Question;
  readonly answerKey: string;
}

/**
 * Parses each question of an ask, field by field, and drops a question that
 * cannot be shown or answered:
 *
 * - one without its text or its header (the chip), because an invented header
 *   would show words the agent never wrote;
 * - one without the vendor's key for its answer, because its answer could not
 *   be sent back;
 * - one whose header or vendor key repeats an earlier question's, because
 *   answers are keyed by header on the way in and by vendor key on the way
 *   out, and two equal keys cannot both be answered;
 * - a secret one (Codex `isSecret`), because the protocol has no way to hide
 *   an answer, so it would be shown and stored in plain text.
 *
 * A missing `multiSelect` means one answer, because a harness with no such
 * field always asks for one.
 */
const parseQuestions = (given: unknown, keyField: AnswerKeyField): ReadonlyArray<KeyedQuestion> => {
  if (!Array.isArray(given)) return [];
  const headers = new Set<string>();
  const answerKeys = new Set<string>();
  return given.flatMap((one: unknown) => {
    if (typeof one !== "object" || one === null) return [];
    const fields = one as {
      readonly question?: unknown;
      readonly id?: unknown;
      readonly header?: unknown;
      readonly options?: unknown;
      readonly multiSelect?: unknown;
      readonly isSecret?: unknown;
    };
    const { question, header, options, multiSelect, isSecret } = fields;
    const answerKey = fields[keyField];
    if (typeof question !== "string" || question === "") return [];
    if (typeof header !== "string" || header === "") return [];
    if (typeof answerKey !== "string" || answerKey === "") return [];
    if (isSecret === true) return [];
    const shownHeader = truncateFact(header);
    if (headers.has(shownHeader) || answerKeys.has(answerKey)) return [];
    headers.add(shownHeader);
    answerKeys.add(answerKey);
    return [
      {
        question: {
          question: truncateMessage(question),
          header: shownHeader,
          options: parseOptions(options),
          multiSelect: multiSelect === true,
        },
        answerKey,
      },
    ];
  });
};

/**
 * Builds the open request for an ask. A question request offers only deny
 * and cancel as decisions: it is answered with answers, and an allow would run
 * the tool with no answer in it.
 *
 * When no question in the ask can be parsed, the request is a `tool_approval`
 * named after the tool instead. The controller rejects a `question` request
 * with no questions, and the runner would drop it, leaving the session parked.
 * A `tool_approval` request can still be denied.
 */
export const buildQuestionRequest = (
  identity: { readonly requestId: string; readonly itemId: string },
  toolName: string,
  given: unknown,
  keyField: AnswerKeyField,
): OpenRequest => {
  const common = { ...identity, decisions: ["deny", "cancel"] } as const;
  const [first, ...rest] = parseQuestions(given, keyField).map((one) => one.question);
  return first === undefined
    ? { ...common, kind: "tool_approval", detail: { toolName: truncateFact(toolName) } }
    : { ...common, kind: "question", detail: { questions: [first, ...rest] } };
};

/**
 * Converts the user's answers, keyed by the headers the request showed, into
 * a list per question keyed by the vendor's key for its answer. A single
 * answer becomes a list of one.
 *
 * `given` and `keyField` must be what the request was built from. Parsing
 * them again gives the same questions with the same headers, so each header
 * leads back to its vendor key even when the request showed it truncated. A
 * header that matches no question is left out.
 */
export const keyAnswersForVendor = (
  answers: QuestionAnswers,
  given: unknown,
  keyField: AnswerKeyField,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const answerKeys = new Map(
    parseQuestions(given, keyField).map((one) => [one.question.header, one.answerKey]),
  );
  return new Map(
    Object.entries(answers).flatMap(([header, answer]) => {
      const key = answerKeys.get(header);
      return key === undefined ? [] : [[key, typeof answer === "string" ? [answer] : answer]];
    }),
  );
};
