/**
 * What the details pane shows and does for one Task, worked out once:
 * `buildTaskPane` turns the board's cards, the Task's details and the answers
 * the app holds into the card, the question, the actions in the order the
 * sheet shows them, and the words for the answers. The pane draws that value,
 * and every button and the Return key act on that same value. So a chip
 * always answers the question that was drawn, and the buttons never read
 * another card than the one on screen.
 */
import type { TaskDetail, WorkCard } from "@hercule/contract";
import {
  describeHeldAnswer,
  describeUnsentAnswer,
  type HeldAnswerTarget,
  type UnsentAnswer,
  type UnsentAnswerSource,
} from "./held-answers";
import {
  decideQuestionAnswers,
  type AnswerableTaskQuestion,
  type PaneAnswer,
  type TaskQuestion,
} from "./question-answers";

export type TaskActionId =
  | "try-again"
  | "open-run"
  | "open-thread"
  | "done"
  | "start-thread"
  | "merge"
  | "drop";

/** One button of the pane. */
export interface TaskAction {
  readonly id: TaskActionId;
  readonly label: string;
  /** The key that does it, as the keys table writes it, or `null` for a button without one. */
  readonly keyHint: string | null;
  /** True for the one button of its section the pane fills. */
  readonly filled: boolean;
}

/** The actions of one Task's pane. */
export interface TaskActions {
  /** Under a failure: Try again, Open the run. Empty when the Task has no failure. */
  readonly failure: readonly TaskAction[];
  /** Under an open question the pane shows: Open thread. `null` when it shows none. */
  readonly openThread: TaskAction | null;
  /** The foot: Done, Start a thread and Merge on the left, Drop alone at the right. */
  readonly foot: {
    readonly start: readonly TaskAction[];
    readonly end: TaskAction;
  };
  /**
   * What the Return key does while the pane is open, or `null` when it does
   * nothing. A failure leads, so Return tries again even when a question sits
   * under it. Otherwise Return sends the suggested answer of a question the
   * pane answers, when that question has chips and no answer is held for it.
   */
  readonly returnAction: ReturnAction | null;
}

/** What the Return key does in the pane. */
export type ReturnAction =
  | { readonly kind: "try-again" }
  | {
      readonly kind: "send-suggested-answer";
      readonly question: AnswerableTaskQuestion;
      readonly answer: PaneAnswer;
    };

const TRY_AGAIN: TaskAction = { id: "try-again", label: "Try again", keyHint: "↩", filled: true };
const OPEN_RUN: TaskAction = {
  id: "open-run",
  label: "Open the run",
  keyHint: null,
  filled: false,
};
const OPEN_THREAD: TaskAction = {
  id: "open-thread",
  label: "Open thread",
  keyHint: null,
  filled: false,
};
const DONE: TaskAction = { id: "done", label: "Done", keyHint: "D", filled: false };
const START_THREAD: TaskAction = {
  id: "start-thread",
  label: "Start a thread",
  keyHint: "T",
  filled: false,
};
const MERGE: TaskAction = { id: "merge", label: "Merge", keyHint: "M", filled: false };
const DROP: TaskAction = { id: "drop", label: "Drop", keyHint: "⌫", filled: false };

/**
 * Lists the actions of the pane for a Task whose card has this `failure` and
 * whose pane shows this `question`, held as `said`. A failure leads, and a
 * question sits under it, so down the sheet the order is Try again, Open the
 * run, Open thread, Done, Drop. Done and Drop stay in the foot on every Task,
 * failed or not.
 *
 * Open thread is on every question the pane shows, whether the pane answers
 * it or only shows it. A Task with no question to show gets no action.
 */
const listTaskActions = (
  failure: WorkCard["failure"],
  question: TaskQuestion | null,
  said: string | null,
): TaskActions => {
  const suggested =
    question?.kind === "answerable" && said === null
      ? question.chips.find((chip) => chip.suggested)
      : undefined;
  const returnAction: ReturnAction | null =
    failure !== undefined
      ? { kind: "try-again" }
      : question?.kind === "answerable" && suggested !== undefined
        ? {
            kind: "send-suggested-answer",
            question,
            answer: { kind: "chip", label: suggested.label },
          }
        : null;
  return {
    failure: failure !== undefined ? [TRY_AGAIN, OPEN_RUN] : [],
    openThread: question === null ? null : OPEN_THREAD,
    foot: { start: [DONE, START_THREAD, MERGE], end: DROP },
    returnAction,
  };
};

/** What `buildTaskPane` reads. */
export interface TaskPaneFacts {
  readonly taskId: string;
  /** The cards the board shows now, a move not yet answered included. */
  readonly boardCards: readonly WorkCard[];
  /** The Task's details as read, or `undefined` before the first read. */
  readonly detail: Pick<TaskDetail, "card" | "sessions"> | undefined;
  /** True when a read found the Task deleted. Such a Task offers nothing to do. */
  readonly isGone: boolean;
  /** The answers the app holds for sending, of every Task. */
  readonly heldAnswers: readonly HeldAnswerTarget[];
  /** The answers of this Task that were not sent. */
  readonly unsentAnswers: readonly UnsentAnswerSource[];
}

/** Everything the pane shows and does for one Task. */
export interface TaskPaneContent {
  readonly taskId: string;
  /**
   * The Task's card: the board's when the board has it, because the board's
   * card is the newer (it shows a move the controller has not answered), else
   * the card of the details, else `undefined`. The title, the stage and the
   * failure are read from it.
   */
  readonly card: WorkCard | undefined;
  /**
   * The question the pane shows, or `null`. It is read from the details: the
   * board's card has had the question taken off while an answer to it is held.
   */
  readonly question: TaskQuestion | null;
  /** The buttons and the Return key, or `null` for a Task that has no card or no longer exists. */
  readonly actions: TaskActions | null;
  /**
   * What the user said to `question`, while the answer waits in the undo line
   * or is being sent, or `null`. The question's chips and line give way to it.
   */
  readonly said: string | null;
  /** The answers of this Task that were not sent, with their words and what to do about them. */
  readonly unsent: readonly UnsentAnswer[];
}

/**
 * Builds the value the details pane of the Task `facts.taskId` draws and
 * acts on. It never fails: a Task not read yet has no question, and one not
 * on the board nor read has no card.
 */
export const buildTaskPane = (facts: TaskPaneFacts): TaskPaneContent => {
  const { taskId, detail } = facts;
  const card = facts.boardCards.find((each) => each.id === taskId) ?? detail?.card;
  const question = detail === undefined ? null : decideQuestionAnswers(detail);
  const held =
    question === null
      ? undefined
      : facts.heldAnswers.find(
          (each) => each.sessionId === question.sessionId && each.requestId === question.requestId,
        );
  const said = held === undefined ? null : describeHeldAnswer(held.answers);
  return {
    taskId,
    card,
    question,
    actions:
      card === undefined || facts.isGone ? null : listTaskActions(card.failure, question, said),
    said,
    unsent: facts.unsentAnswers.map(describeUnsentAnswer),
  };
};
