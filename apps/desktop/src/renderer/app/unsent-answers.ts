/**
 * Keeps the answers that were not sent on a Task that still exists. An answer
 * is shown on the pane of the Task it was given on, but that Task can be
 * merged into another or deleted while the answer waits, and its pane is then
 * out of reach. This reads such a Task to find out which.
 */
import { isInvalidState, isNotFound, type HerculeClient } from "@hercule/client-core";
import { listUnsentAnswers, type PendingIntents } from "./pending-intents";

/**
 * Settles the failed answers of each of the Tasks `taskIds`, one Task at a
 * time, by reading the Task's details:
 *
 * - The read answers with another Task: the Task was merged into it, so the
 *   answers move to that Task's pane. They still go to the Thread and
 *   Request they were given for.
 * - The read says the Task is deleted (`not_found`): nothing can be done
 *   with the answers there, so they are discarded.
 * - The read says the Task is finished (`invalid_state`), answers with the
 *   same Task, or fails in any other way (the controller cannot be reached):
 *   the answers stay. A finished Task can be moved back, and the Thread's
 *   question may still be open, so its words are never deleted.
 *
 * Returns whether the controller gave an answer to every read, a refusal
 * included. It is `false` after a read that got none (the controller cannot be
 * reached, or failed), so the caller tries again later.
 *
 * Call it for a Task the board does not show, and never because the board
 * omits a Task: the board is cut at a limit, so a missing card says nothing
 * about the Task. Never rejects.
 */
export const settleUnsentAnswers = async (
  client: HerculeClient,
  store: PendingIntents,
  taskIds: readonly string[],
): Promise<boolean> => {
  let isEverySettled = true;
  for (const taskId of taskIds) {
    try {
      const detail = await client.task.readDetail({ params: { id: taskId } });
      if (detail.task.id !== taskId) store.moveFailedAnswers(taskId, detail.task.id);
    } catch (error) {
      if (isNotFound(error)) {
        for (const answer of listUnsentAnswers(store.getSnapshot(), taskId)) {
          store.discard(answer.intentId);
        }
      } else if (!isInvalidState(error)) {
        isEverySettled = false;
      }
    }
  }
  return isEverySettled;
};
