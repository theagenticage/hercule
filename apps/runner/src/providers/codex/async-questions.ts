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
import type { NotificationFrame } from "./rpc";
import type { ItemCompletedNotification } from "./types";

/** One question as Codex's `agentMessage` item holds it. */
export interface NativeAsyncQuestion {
  readonly title: string;
  readonly options: ReadonlyArray<string> | null;
}

/** A completed `agentMessage` item that asks async questions. */
export interface AsyncQuestionItem {
  readonly id: string;
  readonly questions: ReadonlyArray<NativeAsyncQuestion>;
}

/**
 * Returns the async questions a notification carries, or `undefined` when it
 * is not an `item/completed` for an `agentMessage` that asks some. Throws when
 * an `item/completed` frame has no readable params.
 */
export const readAsyncQuestionItem = (frame: NotificationFrame): AsyncQuestionItem | undefined => {
  if (frame.method !== "item/completed") return undefined;
  const { item } = frame.params as ItemCompletedNotification;
  if (item.type !== "agentMessage" || item.delivery !== "async") return undefined;
  if (item.questions == null || item.questions.length === 0) return undefined;
  return { id: item.id, questions: item.questions };
};

/**
 * Where an async question is in its life. The adapter holds one record per
 * Request that is still answerable:
 *
 * - `open`: no answer is on its way. The user can answer it.
 * - `delivering`: an answer is being sent to Codex. A second answer is refused.
 */
export type AsyncQuestionState = "open" | "delivering";

/** An async question the user can still answer, with what the answer needs. */
export interface AsyncQuestion {
  readonly requestId: string;
  /** The id Codex gave the `agentMessage` item, which the reply envelope names. */
  readonly nativeItemId: string;
  /**
   * The text of each question as the reply envelope and the readable answer
   * repeat it: line breaks replaced by spaces, cut to 512 UTF-8 bytes. Both
   * use this one text, so a title cannot break out of the quote the
   * transcript draws around it.
   */
  readonly replyQuestions: ReadonlyArray<string>;
  /** The header each question shows, in order; the answers come back keyed by them. */
  readonly headers: ReadonlyArray<string>;
  state: AsyncQuestionState;
}

/** The only tool that produces these items; the reply envelope's question ids name it. */
const ASYNC_QUESTION_TOOL = "request_user_input_async";

/** The longest question text, in UTF-8 bytes, that the reply envelope carries. */
const MAX_ENVELOPE_QUESTION_BYTES = 512;

/**
 * The most async questions a session keeps open. The asking tool has no limit
 * of its own, and every open question is a Request the user must see.
 */
export const MAX_OPEN_ASYNC_QUESTIONS = 8;

/** Returns the Request id of the async question in the item with this native id. */
const buildAsyncQuestionRequestId = (nativeItemId: string): string =>
  ensureId(`${ASYNC_QUESTION_TOOL}:${nativeItemId}`);

/** Returns the headers of `count` questions: one plain header, or a numbered header for each. */
const buildHeaders = (count: number): ReadonlyArray<string> =>
  count === 1
    ? ["Question"]
    : Array.from({ length: count }, (_, index) => `Question ${String(index + 1)}`);

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
      replyQuestions: questions.map((native) =>
        cutToBytes(native.title, MAX_ENVELOPE_QUESTION_BYTES),
      ),
      headers,
      state: "open",
    },
  };
};

/**
 * Returns each question's answer as one text, in the order of the question's
 * headers: an answer given as a list is joined with ", ". The controller has
 * already checked that every question has an answer.
 */
export const readAnswerTexts = (
  question: AsyncQuestion,
  answers: QuestionAnswers,
): ReadonlyArray<string> =>
  question.headers.map((header) => {
    const answer = answers[header]!;
    return typeof answer === "string" ? answer : answer.join(", ");
  });

/**
 * Builds the text that answers an async question: the reply envelope the Codex
 * clients send, with one entry per question. Codex hands it to the model as a
 * user message. Each entry names the question by the item it came from and its
 * index, and repeats the question text cut to 512 UTF-8 bytes.
 *
 * `<` and `>` are written as JSON escapes, so that neither a question nor an
 * answer can contain the closing tag and end the envelope early. The JSON
 * parses back to the same text.
 */
export const buildAnswerEnvelope = (
  question: AsyncQuestion,
  answerTexts: ReadonlyArray<string>,
): string => {
  const replies = question.replyQuestions.map((text, index) => ({
    answer: answerTexts[index],
    question: text,
    questionItemId: JSON.stringify([ASYNC_QUESTION_TOOL, question.nativeItemId, index]),
  }));
  const json = JSON.stringify(replies).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return `<send_user_message_question_reply>\n${json}\n</send_user_message_question_reply>`;
};

/**
 * Builds the text the transcript shows as the user's message for an answer, as
 * the Codex terminal shows it: `> <question>`, a blank line and the answer,
 * with a blank line between questions. The question is the one-line text the
 * envelope carries. The raw envelope is never shown.
 */
export const buildAnswerMessage = (
  question: AsyncQuestion,
  answerTexts: ReadonlyArray<string>,
): string =>
  question.replyQuestions.map((text, index) => `> ${text}\n\n${answerTexts[index]}`).join("\n\n");
