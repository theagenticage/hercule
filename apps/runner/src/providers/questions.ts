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
 *   the user can deny and a frame the controller drops;
 * - the answers come back keyed by the headers the request showed, so the
 *   headers must be unique, and only the adapter can make them unique: it is
 *   the one place that knows each header's vendor key.
 *
 * Every field is read defensively. The input is whatever the vendor sent, and
 * one field of the wrong type would otherwise produce a frame the runner
 * drops. That loses the event and leaves the session parked with no way out.
 */
import {
  MAX_FACT_LENGTH,
  type OpenRequest,
  type Question,
  type QuestionAnswers,
} from "@hercule/protocol";
import { truncateFact, truncateMessage } from "./text";

/**
 * Parses the options of one question. The user picks from them, and the
 * description of each is part of the question: a user who reads only the
 * question text cannot see what an option means.
 *
 * Fields the protocol has no place for, such as the Claude SDK's `preview`,
 * are dropped. So is an option with no label or with no description string,
 * and an option whose label repeats an earlier option's: a picked option is
 * sent back as its label, so two options with one label cannot be told apart.
 */
const parseOptions = (given: unknown): ReadonlyArray<Question["options"][number]> => {
  if (!Array.isArray(given)) return [];
  const labels = new Set<string>();
  return given.flatMap((option: unknown) => {
    if (typeof option !== "object" || option === null) return [];
    const { label, description } = option as {
      readonly label?: unknown;
      readonly description?: unknown;
    };
    if (typeof label !== "string" || label === "" || typeof description !== "string") return [];
    const shownLabel = truncateFact(label);
    if (labels.has(shownLabel)) return [];
    labels.add(shownLabel);
    return [{ label: shownLabel, description: truncateMessage(description) }];
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
 * Returns `header`, truncated to fit the protocol, or, when an earlier
 * question already shows that header, the header with the first free number
 * after it: the second "Approach" becomes "Approach (2)". The answers come
 * back keyed by header, so two questions showing one header could not both
 * be answered. Claude Code checks only that question texts are unique, so two
 * of its questions can share a header.
 */
const buildUniqueHeader = (header: string, taken: ReadonlySet<string>): string => {
  const shown = truncateFact(header);
  if (!taken.has(shown)) return shown;
  for (let number = 2; ; number++) {
    const suffix = ` (${String(number)})`;
    const numbered = `${header.slice(0, MAX_FACT_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(numbered)) return numbered;
  }
};

/**
 * Parses each question of an ask, field by field. Parsing the same input
 * again gives the same questions with the same headers, which is what lets
 * `keyAnswersForVendor` find each answer's question. It drops a question that
 * cannot be shown or answered:
 *
 * - one without its text or its header (the chip), because an invented header
 *   would show words the agent never wrote;
 * - one without the vendor's key for its answer, because its answer could not
 *   be sent back;
 * - one whose vendor key repeats an earlier question's, because the vendor
 *   reads one answer per key, so the earlier question's answer is the only
 *   one it can receive.
 *
 * A repeated header is numbered rather than dropped (see
 * `buildUniqueHeader`). A missing `multiSelect` means one answer, because a
 * harness with no such field always asks for one. A secret question (Codex
 * `isSecret`) is kept and marked `secret`, so the surfaces can warn that its
 * answer is stored like any other.
 */
const parseQuestions = (given: unknown, keyField: AnswerKeyField): ReadonlyArray<KeyedQuestion> => {
  if (!Array.isArray(given)) return [];
  const headers = new Set<string>();
  const answerKeys = new Set<string>();
  return given.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const fields = entry as {
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
    if (answerKeys.has(answerKey)) return [];
    const shownHeader = buildUniqueHeader(header, headers);
    headers.add(shownHeader);
    answerKeys.add(answerKey);
    return [
      {
        question: {
          question: truncateMessage(question),
          header: shownHeader,
          options: parseOptions(options),
          multiSelect: multiSelect === true,
          ...(isSecret === true ? { secret: true } : {}),
        },
        answerKey,
      },
    ];
  });
};

/**
 * Builds the open request for an ask: a `question` request, answered with
 * answers only.
 *
 * When no question in the ask can be parsed, the request is a `tool_approval`
 * named after the tool instead. The controller rejects a `question` request
 * with no questions, and the runner would drop it, leaving the session parked.
 * The `tool_approval` offers only deny and cancel, because an allow would run
 * the tool with no answer in it.
 */
export const buildQuestionRequest = (
  identity: { readonly requestId: string; readonly itemId: string },
  toolName: string,
  given: unknown,
  keyField: AnswerKeyField,
): OpenRequest => {
  const [first, ...rest] = parseQuestions(given, keyField).map((keyed) => keyed.question);
  return first === undefined
    ? {
        ...identity,
        kind: "tool_approval",
        decisions: ["deny", "cancel"],
        detail: { toolName: truncateFact(toolName) },
      }
    : { ...identity, kind: "question", detail: { questions: [first, ...rest] } };
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
    parseQuestions(given, keyField).map((keyed) => [keyed.question.header, keyed.answerKey]),
  );
  return new Map(
    Object.entries(answers).flatMap(([header, answer]) => {
      const key = answerKeys.get(header);
      return key === undefined ? [] : [[key, typeof answer === "string" ? [answer] : answer]];
    }),
  );
};
