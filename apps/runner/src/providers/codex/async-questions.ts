/**
 * Converts Codex's async questions to Hercule's `question` Requests and
 * converts the user's answers back to the input Codex expects. An async
 * question is a question the asking agent does not wait on. Codex's
 * `request_user_input_async` tool completes one `agentMessage` item with
 * `delivery: "async"` and its questions, and answers it at once with
 * `{"accepted":true}`. No JSON-RPC request is parked, so the answer goes back
 * as an ordinary user input.
 */
import type { OpenRequest, QuestionAnswers } from "@hercule/protocol";
import { ensureId } from "../events";
import { truncateFact, truncateMessage } from "../text";

/** One question as Codex's `agentMessage` item holds it. */
export interface NativeAsyncQuestion {
  readonly title: string;
  readonly options: ReadonlyArray<string> | null;
}

/**
 * Where an async question is in its life. The adapter holds one record per
 * Request that is still answerable:
 *
 * - `open`: no answer is on its way. The user can answer it.
 * - `delivering`: an answer is being sent to Codex. A second answer is refused.
 * - `unconfirmed`: an answer was sent and it is not known whether Codex took
 *   it. The answer is never sent again, because Codex could receive it twice.
 */
export type AsyncQuestionState = "open" | "delivering" | "unconfirmed";

/** An async question the user can still answer, with what the answer needs. */
export interface AsyncQuestion {
  readonly requestId: string;
  /** The id Codex gave the `agentMessage` item, which the reply envelope names. */
  readonly nativeItemId: string;
  /** The titles Codex wrote, whole, in order. The Request shows them cut to the protocol's limit. */
  readonly titles: ReadonlyArray<string>;
  /** The header each question shows, in order; the answers come back keyed by them. */
  readonly headers: ReadonlyArray<string>;
  state: AsyncQuestionState;
}

/** The only tool that produces these items; the reply envelope's question ids name it. */
const ASYNC_QUESTION_TOOL = "request_user_input_async";

/** The longest question text, in UTF-8 bytes, that the reply envelope carries. */
const MAX_ENVELOPE_QUESTION_BYTES = 512;

/** Returns the Request id of the async question in the item with this native id. */
const buildAsyncQuestionRequestId = (nativeItemId: string): string =>
  ensureId(`${ASYNC_QUESTION_TOOL}:${nativeItemId}`);

/** Returns the headers of `count` questions: one plain header, or a numbered header for each. */
const buildHeaders = (count: number): ReadonlyArray<string> =>
  count === 1
    ? ["Question"]
    : Array.from({ length: count }, (_, index) => `Question ${String(index + 1)}`);

/**
 * Builds the Request that asks an async question's questions. The title is the
 * question; the header is "Question", or "Question 1" to "Question n" when
 * there are several. Options carry no description, because Codex gives none,
 * and an option that is empty or repeats an earlier label is dropped, as for a
 * blocking question. A question with no options is answered in free text.
 * Returns the record the adapter keeps beside the Request.
 */
export const buildAsyncQuestion = (
  nativeItemId: string,
  questions: ReadonlyArray<NativeAsyncQuestion>,
): { readonly request: OpenRequest; readonly question: AsyncQuestion } => {
  const requestId = buildAsyncQuestionRequestId(nativeItemId);
  const headers = buildHeaders(questions.length);
  const shown = questions.map((native, index) => ({
    question: truncateMessage(native.title),
    header: headers[index]!,
    options: [
      ...new Set((native.options ?? []).filter((label) => label !== "").map(truncateFact)),
    ].map((label) => ({ label })),
    multiSelect: false,
  }));
  const [first, ...rest] = shown;
  return {
    request: {
      requestId,
      itemId: ensureId(nativeItemId),
      kind: "question",
      async: true,
      detail: { questions: [first!, ...rest] },
    },
    question: {
      requestId,
      nativeItemId,
      titles: questions.map((native) => native.title),
      headers,
      state: "open",
    },
  };
};

/**
 * Returns `text` cut to at most `maxBytes` UTF-8 bytes, without splitting a
 * character, with each line break replaced by a space.
 */
const cutToBytes = (text: string, maxBytes: number): string => {
  const flat = text.replace(/[\r\n]/g, " ");
  let bytes = 0;
  let cut = "";
  for (const character of flat) {
    bytes += Buffer.byteLength(character);
    if (bytes > maxBytes) break;
    cut += character;
  }
  return cut;
};

/**
 * Returns each question's answer as one text, in the order of the question's
 * headers: an answer given as a list is joined with ", ". Returns `undefined`
 * when a question has no answer.
 */
export const readAnswerTexts = (
  question: AsyncQuestion,
  answers: QuestionAnswers,
): ReadonlyArray<string> | undefined => {
  const texts: Array<string> = [];
  for (const header of question.headers) {
    const answer = answers[header];
    if (answer === undefined) return undefined;
    texts.push(typeof answer === "string" ? answer : answer.join(", "));
  }
  return texts;
};

/**
 * Builds the text that answers an async question: the reply envelope the Codex
 * clients send, with one entry per question. Codex hands it to the model as a
 * user message. Each entry names the question by the item it came from and its
 * index, and repeats the question text cut to 512 UTF-8 bytes.
 */
export const buildAnswerEnvelope = (
  question: AsyncQuestion,
  answerTexts: ReadonlyArray<string>,
): string => {
  const replies = question.titles.map((title, index) => ({
    answer: answerTexts[index],
    question: cutToBytes(title, MAX_ENVELOPE_QUESTION_BYTES),
    questionItemId: JSON.stringify([ASYNC_QUESTION_TOOL, question.nativeItemId, index]),
  }));
  return `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`;
};

/**
 * Builds the text the transcript shows as the user's message for an answer, as
 * the Codex terminal shows it: `> <question>`, a blank line and the answer,
 * with a blank line between questions. The raw envelope is never shown.
 */
export const buildAnswerMessage = (
  question: AsyncQuestion,
  answerTexts: ReadonlyArray<string>,
): string =>
  question.titles
    .map((title, index) => `> ${truncateMessage(title)}\n\n${answerTexts[index]}`)
    .join("\n\n");
