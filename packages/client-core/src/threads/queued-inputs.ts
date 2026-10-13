/**
 * Where a thread's view draws the session's queued inputs, and what it offers
 * on them. A queued input is not always waiting: the controller may already
 * have handed it to the runner. The view draws what the user expects at Send,
 * not the row's raw status, so a message that goes straight into the session
 * is never shown as queued.
 */
import type { Input, Session } from "@hercule/contract";
import { canSteerOrCancelQueuedInputs } from "../assistants/conversation";

/** A session's queued inputs, split by where the thread's view draws them. */
export interface QueuedInputPlaces {
  /** The inputs that wait for the running turn to end, oldest first. The queue above the composer shows them. */
  readonly waiting: readonly Input[];
  /** The inputs on their way into the session, oldest first. The transcript shows them as being sent. */
  readonly sending: readonly Input[];
}

/**
 * Splits a session's queued inputs by where the thread's view draws them.
 * `inputs` are the session's inputs, oldest first, and any that is not
 * `queued` is left out.
 *
 * An input is sending in two cases:
 *
 * - the controller has handed it to the runner (its `sentAt` is set), on the
 *   idle path, in a start or in a steer;
 * - the session waits to start, and the input is its oldest one that has not
 *   been handed over: the start carries that input.
 *
 * The controller refuses to steer or cancel either one, and the message goes
 * straight in as soon as the session runs. Every other queued input waits
 * for the running turn to end.
 */
export const splitQueuedInputs = (
  session: Session,
  inputs: readonly Input[],
): QueuedInputPlaces => {
  const queued = inputs.filter((input) => input.status === "queued");
  const carriedByStart =
    session.status === "queued" ? queued.find((input) => input.sentAt === null) : undefined;
  return {
    waiting: queued.filter((input) => input.sentAt === null && input !== carriedByStart),
    sending: queued.filter((input) => input.sentAt !== null || input === carriedByStart),
  };
};

/**
 * Checks whether the queue offers Steer on the session's waiting inputs.
 * Only a busy session has a turn to steer an input into, and a session that
 * answers an assistant's conversation offers neither Steer nor Cancel (see
 * `canSteerOrCancelQueuedInputs`).
 */
export const canSteerQueuedInputs = (session: Session): boolean =>
  session.status === "busy" && canSteerOrCancelQueuedInputs(session);
