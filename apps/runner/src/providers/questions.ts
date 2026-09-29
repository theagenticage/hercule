/**
 * Converts the question a harness parks a session on into the one shape every
 * surface renders. It lives in one module for two reasons:
 *
 * - two adapters reading a vendor's questions into slightly different shapes
 *   would give a card whose content depends on the harness, and the
 *   normalized event stream exists so that no surface does (ADR 0007);
 * - the fallback in `buildQuestionRequest` is the difference between a request
 *   the user can deny and a frame the controller drops.
 *
 * Every field is read defensively. The input is whatever the vendor sent, and
 * one field of the wrong type would otherwise produce a frame the runner
 * drops. That loses the event and leaves the session parked with no way out.
 */
import type { OpenRequest } from "@hercule/protocol";
import { truncateFact, truncateMessage } from "./text";

/** One question as the protocol carries it, mapped from the vendor's shape. */
type Question = Extract<OpenRequest, { readonly kind: "question" }>["detail"]["questions"][number];

/**
 * Parses the options of one question. For now they are display only: until an
 * answer can be sent back with the decision, no button can use them. They are
 * still included, because the meaning of each option is part of the question,
 * and a user who reads only the question text cannot see it.
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
 * Parses each question of an ask, field by field. A question without its text
 * or its header (the chip) is dropped rather than filled in, because an
 * invented header would show words the agent never wrote. A missing
 * `multiSelect` means one answer, because a harness with no such field always
 * asks for one.
 */
const parseQuestions = (given: unknown): ReadonlyArray<Question> => {
  if (!Array.isArray(given)) return [];
  return given.flatMap((one: unknown) => {
    if (typeof one !== "object" || one === null) return [];
    const { question, header, options, multiSelect } = one as {
      readonly question?: unknown;
      readonly header?: unknown;
      readonly options?: unknown;
      readonly multiSelect?: unknown;
    };
    if (typeof question !== "string" || question === "") return [];
    if (typeof header !== "string" || header === "") return [];
    return [
      {
        question: truncateMessage(question),
        header: truncateFact(header),
        options: parseOptions(options),
        multiSelect: multiSelect === true,
      },
    ];
  });
};

/**
 * Builds the open request for an ask. The only decisions offered are deny and
 * cancel. Sending the user's answers back is not built yet, so allowing would
 * run the tool with no answer in it.
 *
 * When no question in the ask can be parsed, returns a `tool_approval` request
 * named after the tool instead. The controller rejects a `question` request
 * with no questions, and the runner would drop it, leaving the session parked.
 * A `tool_approval` request can still be denied.
 */
export const buildQuestionRequest = (
  identity: { readonly requestId: string; readonly itemId: string },
  toolName: string,
  given: unknown,
): OpenRequest => {
  const [first, ...rest] = parseQuestions(given);
  const common = { ...identity, decisions: ["deny", "cancel"] } as const;
  return first === undefined
    ? { ...common, kind: "tool_approval", detail: { toolName: truncateFact(toolName) } }
    : { ...common, kind: "question", detail: { questions: [first, ...rest] } };
};
