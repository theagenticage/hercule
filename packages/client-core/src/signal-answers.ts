/**
 * The answers of a signal, in the order and the style the Inbox's pane draws
 * them: the plugin's or the raiser's actions, then each Hand to an agent,
 * then Done. Spec 10 §9 owns the Signal record and its actions.
 */
import {
  DONE_ACTION_ID,
  HAND_TO_ACTION_PREFIX,
  type Signal,
  type SignalAction,
} from "@hercule/contract";

/** How the pane draws an answer. */
export type SignalAnswerStyle =
  /** An action with a `field`: a text box with its button. */
  | "reply"
  /** Done, which the core adds and the user's own list keeps. */
  | "done"
  /** An answer that runs nothing, such as Dismiss: drawn quiet. */
  | "quiet"
  /** Any other answer. */
  | "plain";

/** One answer of a signal, as the pane draws it. */
export interface SignalAnswer {
  readonly action: SignalAction;
  readonly style: SignalAnswerStyle;
  /** Whether this is the signal's suggested answer, its `primary` action. At most one is. */
  readonly suggested: boolean;
  /**
   * The workflow a Hand to an agent answer starts, whose face its button
   * wears, or `null` for every other answer.
   */
  readonly workflowId: string | null;
}

/** Returns how the pane draws `action`. */
const chooseAnswerStyle = (action: SignalAction): SignalAnswerStyle => {
  if (action.id === DONE_ACTION_ID) return "done";
  if (action.field !== undefined) return "reply";
  if (action.operation === null) return "quiet";
  return "plain";
};

/**
 * Returns the workflow a Hand to an agent answer starts: the `workflowId` of
 * the `signal.handOff` the core binds (spec 10 §9.4), or of the `run.start` it
 * bound on signals written before `signal.handOff` existed. Returns `null`
 * for any other answer, a raiser's own `run.start` included.
 */
const readStartedWorkflowId = (action: SignalAction): string | null => {
  if (
    !action.id.startsWith(HAND_TO_ACTION_PREFIX) ||
    (action.operation?.op !== "signal.handOff" && action.operation?.op !== "run.start")
  ) {
    return null;
  }
  const input: unknown = action.operation.input;
  if (typeof input !== "object" || input === null || !("workflowId" in input)) return null;
  return typeof input.workflowId === "string" ? input.workflowId : null;
};

/** Returns where an action goes in the pane: the plugin's actions first, then Hand to an agent, then Done. */
const rankAnswer = (action: SignalAction): number => {
  if (action.id === DONE_ACTION_ID) return 2;
  if (action.id.startsWith(HAND_TO_ACTION_PREFIX)) return 1;
  return 0;
};

/**
 * Returns a signal's answers in the order the pane draws them: the plugin's
 * or the raiser's actions as they were given, then each Hand to an agent,
 * then Done. The `primary` action is the suggested answer.
 */
export const buildSignalAnswers = (signal: Signal): ReadonlyArray<SignalAnswer> =>
  signal.actions
    .toSorted((a, b) => rankAnswer(a) - rankAnswer(b))
    .map((action) => ({
      action,
      style: chooseAnswerStyle(action),
      suggested: action.primary === true,
      workflowId: readStartedWorkflowId(action),
    }));

/** Returns the suggested answer among `answers`, or `undefined` when the signal suggests none. */
export const findSuggestedAnswer = (
  answers: ReadonlyArray<SignalAnswer>,
): SignalAnswer | undefined => answers.find((answer) => answer.suggested);

/**
 * Returns an answer's label without the ellipsis at its end, if it has one:
 * "Reply…" becomes "Reply". The ellipsis means the answer asks for more,
 * such as a typed reply, so a button or a sentence that already asks drops it.
 */
export const trimAnswerEllipsis = (label: string): string => label.replace(/…$/, "");
