/**
 * Answering a Thread's question from the details pane. The answer is not sent
 * at once: it waits in the pending intents (`app/pending-intents.ts`) for the
 * undo line, then goes out as `session.respondToQuestion`. Because the store
 * lives in the controller and not in this screen, the send still happens when
 * the user leaves Work meanwhile.
 */
import {
  buildPaneAnswers,
  describeAnswerGiven,
  type AnswerableTaskQuestion,
  type PaneAnswer,
} from "@hercule/client-core/work";
import type { CardMover } from "../../../app/card-mover";
import {
  findHeldAnswer,
  listFailedAnswers,
  type PendingIntents,
} from "../../../app/pending-intents";
import type { Gesture } from "../../../app/undo-stack";
import { holdWithUndo } from "../../../app/use-pending-intents";

/** What the screen lends the answer, to show its result and close the pane. */
export interface PaneAnswerCallbacks {
  /**
   * Shows `text` on the undo line with Undo, and puts `gesture` on the undo
   * stack. Returns a function that takes it off again.
   */
  readonly sayWithUndo: (text: string, gesture: Gesture<CardMover>) => () => void;
  /** Shows `text` on the undo line with no Undo. */
  readonly sayWithoutUndo: (text: string) => void;
  /** Closes the details pane. */
  readonly closePane: () => void;
}

/**
 * Answers `question` of the Task `taskId` with `answer`, a chip or the user's
 * own words. `question` is the one the pane drew, which it takes from the
 * content of the pane (`buildTaskPane`). The pane closes at once and the undo
 * line offers Undo for as long as the answer is held.
 *
 * Does nothing when the question already has an answer held or being sent,
 * which a second press or Return would otherwise answer twice. When the words
 * are refused, the undo line says so, nothing is held, and the pane stays open.
 *
 * An earlier answer to the same question that was not sent is replaced: the
 * new answer is the one the user wants sent.
 */
export const answerFromPane = (
  store: PendingIntents,
  taskId: string,
  question: AnswerableTaskQuestion,
  answer: PaneAnswer,
  callbacks: PaneAnswerCallbacks,
): void => {
  if (findHeldAnswer(store.getSnapshot(), question.sessionId, question.requestId) !== undefined) {
    return;
  }
  const built = buildPaneAnswers(question, answer);
  if (built.kind === "refuse") {
    if (built.notice !== null) callbacks.sayWithoutUndo(built.notice);
    return;
  }
  for (const intent of listFailedAnswers(store.getSnapshot())) {
    if (intent.sessionId === question.sessionId && intent.requestId === question.requestId) {
      store.discard(intent.intentId);
    }
  }
  const words = describeAnswerGiven(built.answers);
  holdWithUndo(
    store,
    {
      kind: "answer",
      taskId,
      sessionId: question.sessionId,
      requestId: question.requestId,
      answers: built.answers,
    },
    { sayWithUndo: callbacks.sayWithUndo, line: `${words}.`, words },
  );
  callbacks.closePane();
};
