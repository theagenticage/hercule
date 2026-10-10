/**
 * What the controller sends a runner for one stored input: the `TurnInput` a
 * `sessionInput` or `sessionStart` frame carries, and the step key of an agent
 * step's prompt.
 */
import type { TurnInput, WorkspaceStepKey } from "@hercule/protocol";
import { parseSessionStamp } from "../actor";
import type { StoredInput } from "./inputs";
import type { StoredSession } from "./repository";

/**
 * Builds the step key of an agent step's prompt: the run and the step its
 * session was started by, and the prompt's `iteration`.
 *
 * Throws when the session was started by no step. Only an agent step creates
 * a step prompt, in the session it started, so that is a bug. Inside an
 * effect the throw is a defect.
 */
export const buildStepKey = (
  session: Pick<StoredSession, "id" | "runId" | "stepId">,
  iteration: number,
): WorkspaceStepKey => {
  if (session.runId === null || session.stepId === null) {
    throw new Error(
      `session ${session.id} holds the prompt of an agent step, but no step started it`,
    );
  }
  return { runId: session.runId, stepId: session.stepId, iteration };
};

/**
 * Builds what a frame carries to the runner for one stored input. A
 * `sessionInput` and a `sessionStart` carry the same shape:
 *
 * - its text, and its images when it has any;
 * - the session's current model selection;
 * - for an agent step's prompt, the step's key, so the runner knows the turn
 *   the prompt starts is the step's and reports its result;
 * - `senderSessionId`, when another session's agent sent the input as a
 *   message: the row's source is `user`, its actor is `session:<id>`, and that
 *   id is not the receiving session's own. A session that spawned this one
 *   counts, because the spawn stores its prompt the same way.
 *
 * The sender comes from the stored actor, which the controller took from the
 * caller's credential, so no caller can choose it. Any other input has no
 * sender: the owner's, a run's, a session's message to itself, and every
 * input a subscription, a heartbeat or a reminder created.
 *
 * Throws, as a defect, on a step prompt whose session was started by no step
 * (`buildStepKey`).
 */
export const buildTurnInput = (
  session: Pick<StoredSession, "id" | "runId" | "stepId" | "modelSelection">,
  row: StoredInput,
): TurnInput => {
  const senderSessionId = row.source === "user" ? parseSessionStamp(row.actor) : undefined;
  return {
    text: row.text,
    ...(row.attachments.length === 0 ? {} : { attachments: row.attachments }),
    modelSelection: session.modelSelection,
    ...(row.stepIteration === null ? {} : { step: buildStepKey(session, row.stepIteration) }),
    ...(senderSessionId === undefined || senderSessionId === session.id ? {} : { senderSessionId }),
  };
};
