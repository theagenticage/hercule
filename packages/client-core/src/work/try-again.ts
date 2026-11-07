/** The words of Try again on the details pane and of its Undo. */
import type { TryAgainUndo } from "@hercule/contract";
import type { EndStage } from "./card-change";

/** Returns what the undo line says after Try again, in the past tense like a move: `Tried again on Review PR`. */
export const describeTryAgain = (title: string): string => `Tried again on ${title}`;

/** What Undo of Try again did, for the undo line. */
export type TryAgainUndoResult =
  | { readonly kind: "put-back" }
  | {
      readonly kind: "stayed";
      /** Why nothing was put back, and whether the run was asked to stop. */
      readonly reason: string;
    };

const TOO_LATE = "The run had already ended, so nothing was put back.";
const NEWER_WORK = "Something newer holds this Task, so what it shows now stays.";
const ASKED_TO_STOP = "The run was asked to stop.";

/**
 * Describes the controller's answer to Undo of Try again. `restored` puts the
 * failure back. `stopped` and `too-late` leave the Task as it is, and the
 * reason says why. The words never claim that the run has stopped: when it
 * was asked to stop, the reason says only that it was asked.
 */
export const describeTryAgainUndo = (answer: TryAgainUndo): TryAgainUndoResult => {
  if (answer.outcome === "restored") return { kind: "put-back" };
  if (answer.outcome === "too-late") return { kind: "stayed", reason: TOO_LATE };
  const why = answer.reason ?? NEWER_WORK;
  return { kind: "stayed", reason: answer.stopRequested ? `${why} ${ASKED_TO_STOP}` : why };
};

/**
 * Returns what the undo line says when Done or Drop is refused because Try
 * again is still starting the Task's run: `Review PR is starting again, so it
 * cannot be marked Done yet. Try again in a moment.` Ending the Task then
 * would race the run that is being started.
 */
export const describeEndWhileTryingAgain = (title: string, stage: EndStage): string =>
  `${title} is starting again, so it cannot be ${stage === "done" ? "marked Done" : "Dropped"} yet. Try again in a moment.`;
