/**
 * The words and the card changes for a question the user answered from the
 * details pane. The answer waits in the undo line before it is sent, and may
 * fail when it is. The app keeps those answers (`pending-intents.ts` in the
 * desktop renderer); these functions turn them into what the board and the
 * pane show.
 */
import type { QuestionAnswers, WorkCard } from "@hercule/contract";
import type { ShownWorkCard } from "./card-words";

/** The longest answer, in characters, that a line quotes before it is cut. */
const MAX_QUOTED_ANSWER = 60;

/**
 * Returns the answers as one quoted line of words: every answer in order,
 * joined with a comma, cut with an ellipsis when it is long. A question with
 * several choices keeps all of them, because the answers are what was sent.
 */
const quoteAnswers = (answers: QuestionAnswers): string => {
  const words = Object.values(answers)
    .flatMap((answer) => (typeof answer === "string" ? [answer] : answer))
    .map((answer) => answer.replace(/\s+/g, " ").trim())
    .filter((answer) => answer !== "")
    .join(", ");
  const cut =
    words.length > MAX_QUOTED_ANSWER ? `${words.slice(0, MAX_QUOTED_ANSWER).trimEnd()}…` : words;
  return `“${cut}”`;
};

/** Returns what the pane shows in place of a question the user just answered: `You said: “Ship it”.` */
export const describeHeldAnswer = (answers: QuestionAnswers): string =>
  `You said: ${quoteAnswers(answers)}.`;

/** Returns what the undo line says after an answer, in the past tense like a move: `Answered “Ship it”`. */
export const describeAnswerGiven = (answers: QuestionAnswers): string =>
  `Answered ${quoteAnswers(answers)}`;

/** The question of a card that an answer is held for (the Thread and the Request), and the answer. */
export interface HeldAnswerTarget {
  readonly sessionId: string;
  readonly requestId: string;
  readonly answers: QuestionAnswers;
}

/**
 * Returns `cards` with the open question taken off each card whose question
 * is one of `held`, so the board draws it as answered: the mark goes, the
 * colleague goes back to work, and the second line says what the user
 * answered (`heldAnswer`, read by `chooseCardSecondLine`). This is display only: nothing counts as
 * answered until the controller accepts the answer, and a card whose answer
 * failed is not in `held`, so its question comes back.
 *
 * Returns the same array when no card changes, and the same object for every
 * card that does not, so a memoized card does not draw again.
 */
export const showHeldAnswers = (
  cards: readonly WorkCard[],
  held: readonly HeldAnswerTarget[],
): readonly ShownWorkCard[] => {
  if (held.length === 0) return cards;
  const findHeld = (card: WorkCard): HeldAnswerTarget | undefined =>
    card.openQuestion === undefined
      ? undefined
      : held.find(
          (each) =>
            each.sessionId === card.openQuestion?.sessionId &&
            each.requestId === card.openQuestion.requestId,
        );
  if (!cards.some((card) => findHeld(card) !== undefined)) return cards;
  return cards.map((card): ShownWorkCard => {
    const target = findHeld(card);
    if (target === undefined) return card;
    const { openQuestion, ...answered } = card;
    void openQuestion;
    return { ...answered, heldAnswer: describeHeldAnswer(target.answers) };
  });
};

/** What an answer that was not sent holds, as the app keeps it. */
export interface UnsentAnswerSource {
  readonly intentId: string;
  readonly sessionId: string;
  readonly answers: QuestionAnswers;
  readonly failure: {
    /**
     * `send-failed`: the controller refused it or could not be reached;
     * `no-longer-open`: the question had closed when the answer was sent again;
     * `interrupted`: the app closed while it waited or was being sent.
     */
    readonly reason: "send-failed" | "no-longer-open" | "interrupted";
    readonly message: string;
  };
}

/** One button under an answer that was not sent. */
export interface UnsentAnswerAction {
  readonly id: "send-again" | "open-thread" | "discard";
  readonly label: string;
}

/** An answer that was not sent, as the pane draws it. */
export interface UnsentAnswer {
  readonly intentId: string;
  /** The Thread the answer was for, which Open thread opens. */
  readonly sessionId: string;
  /** The user's words, quoted. They stay until the user sends them again or discards them. */
  readonly said: string;
  /** Why it was not sent, and what that means for the answer. */
  readonly notice: string;
  readonly actions: readonly UnsentAnswerAction[];
}

const SEND_AGAIN: UnsentAnswerAction = { id: "send-again", label: "Send again" };
const OPEN_THREAD: UnsentAnswerAction = { id: "open-thread", label: "Open thread" };
const DISCARD: UnsentAnswerAction = { id: "discard", label: "Discard" };

/**
 * Describes an answer that was not sent, for the pane:
 *
 * - `send-failed`: the controller's message, then Send again and Discard.
 * - `interrupted`: the app closed first, then Send again and Discard. The
 *   answer is never sent by itself after a restart, because it may have been
 *   sent already.
 * - `no-longer-open`: the question closed, and the answer may have reached it
 *   before it did. Sending it again could only reach another question, so the
 *   pane offers Open thread and Discard, never Send again.
 */
export const describeUnsentAnswer = (source: UnsentAnswerSource): UnsentAnswer => {
  const said = `Your answer: ${quoteAnswers(source.answers)}`;
  const base = { intentId: source.intentId, sessionId: source.sessionId, said };
  switch (source.failure.reason) {
    case "send-failed": {
      const message = source.failure.message.replace(/\.+$/, "");
      return {
        ...base,
        notice: `It was not sent: ${message}.`,
        actions: [SEND_AGAIN, DISCARD],
      };
    }
    case "interrupted":
      return {
        ...base,
        notice: "The app closed before it was sent.",
        actions: [SEND_AGAIN, DISCARD],
      };
    case "no-longer-open":
      return {
        ...base,
        notice: "This question is no longer open, and your answer may have reached it.",
        actions: [OPEN_THREAD, DISCARD],
      };
  }
};
