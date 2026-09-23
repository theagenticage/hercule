/**
 * The question a harness parks a session on, in the one shape every surface
 * renders. One module, because two adapters reading a vendor's questions into
 * two slightly different shapes is a card whose content depends on which
 * harness asked (ADR 0007), and because the fallback below is the difference
 * between a refusable park and a frame the controller drops.
 *
 * Every field is read defensively: what arrives here is whatever a vendor put
 * on the wire, and one field of the wrong type would otherwise be a frame the
 * runner drops, which loses the event and leaves the park hanging.
 */
import type { OpenRequest } from "@hercule/protocol";
import { truncateFact, truncateMessage } from "./text";

/** One question as the protocol carries it: the vendor's shape mapped over. */
type Question = Extract<OpenRequest, { readonly kind: "question" }>["detail"]["questions"][number];

/**
 * The options of one question, read-only for now: until an answer can travel
 * back with the decision there is no button for them to be. They are carried
 * anyway, because what each answer would have meant is what the question is
 * about, and a user reading only the prose cannot see it.
 *
 * An option the protocol has no field for - the Claude SDK's `preview` - is
 * left behind, and one with no label has nothing to show, so it is dropped.
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
 * Each question of an ask, field by field. One missing what the card reads it
 * by - its prose or its chip - is dropped rather than guessed at: an invented
 * header is a word the agent never wrote. A harness with no field for
 * `multiSelect` asks for one answer, which is what its absence reads as.
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
 * The ask as a request the user can answer. Answering a question with its
 * answers is not built, so an allow would run the tool with no answer in it:
 * the two refusals are the only honest offers either way.
 *
 * Where nothing decodable was asked the request is a `tool_approval` named
 * after the ask instead: a `question` request carrying no question is a frame
 * the controller refuses, which the runner drops, leaving the park hanging,
 * while the ask under it is still refusable.
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
