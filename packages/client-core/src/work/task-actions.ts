/**
 * The actions of the details pane, in the order the sheet shows them. The
 * pane draws and wires what this returns; it decides no label, no key and no
 * order of its own.
 */
import type { WorkCard } from "@hercule/contract";
import type { TaskQuestion } from "./question-answers";

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
   * What the Return key does while the pane is open. A failure leads, so
   * Return tries again even when a question sits under it. Otherwise Return
   * sends the suggested answer of a question the pane answers, when that
   * question has chips.
   */
  readonly returnKey: "try-again" | "send-suggested-answer" | null;
}

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
 * What the actions depend on. The caller picks where each comes from, so the
 * pane's buttons and its Return key read the same card for the failure.
 */
export interface TaskActionFacts {
  /** The failure of the Task's card, or `undefined` for a Task that has none. */
  readonly failure: WorkCard["failure"];
  /** The question the pane shows (`decideQuestionAnswers`), or `null` when it shows none. */
  readonly question: TaskQuestion | null;
}

/**
 * Lists the actions of the pane for a Task with these `facts`. A failure
 * leads, and a question sits under it, so down the sheet the order is Try
 * again, Open the run, Open thread, Done, Drop. Done and Drop stay in the foot
 * on every Task, failed or not.
 *
 * Open thread is on every question the pane shows, whether the pane answers
 * it or only shows it. A Task with no question to show gets no action.
 */
export const listTaskActions = ({ failure, question }: TaskActionFacts): TaskActions => {
  const failed = failure !== undefined;
  const hasSuggestedAnswer = question?.kind === "answerable" && question.chips.length > 0;
  return {
    failure: failed ? [TRY_AGAIN, OPEN_RUN] : [],
    openThread: question === null ? null : OPEN_THREAD,
    foot: { start: [DONE, START_THREAD, MERGE], end: DROP },
    returnKey: failed ? "try-again" : hasSuggestedAnswer ? "send-suggested-answer" : null,
  };
};
