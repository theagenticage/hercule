/**
 * Making a Task wait on another and taking a blocker away, from the details
 * pane (`task.addBlocker`, `task.removeBlocker`). Each change is one gesture
 * with an Undo, sent the way `useUndoableTaskChanges` sends every change of a
 * Task: an Undo of an added blocker removes it, and an Undo of a removal adds
 * it again.
 *
 * A blocker that would make Tasks wait on each other in a loop is refused with
 * `InvalidState` and the reason `blocker-cycle`. The controller's message
 * names the path, and `addBlocker` hands it back so the pane can show it under
 * its Blocked by section, where the user is looking. The undo line says only
 * that the change was not made. The reason is never read from the message.
 */
import { useQueryClient } from "@tanstack/react-query";
import {
  invalidateWithoutCancelling,
  isBlockerCycle,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import {
  describeBlockerDone,
  describeBlockerFailure,
  describeBlockerGesture,
  describeBlockerLoopRefused,
  describeBlockerNothing,
  reverseBlockerDirection,
  type BlockerDirection,
} from "@hercule/client-core/work";
import type { AccountScope } from "../../../app/account-scope";
import { readReason } from "../../../app/read-reason";
import type { CardMoves } from "./-card-moves";
import { useUndoableTaskChanges, type TaskChangeAnswer } from "./-undoable-task-change";

/** The Task that waits and the Task it waits on, as the undo line names them. */
export interface TaskBlockerChange {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly blockerId: string;
  readonly blockerTitle: string;
}

/** What `useTaskBlockers` returns. */
export interface TaskBlockers {
  /**
   * Makes the Task wait on the blocker. The undo line says so and offers
   * Undo, which removes it. Resolves to the controller's message when it
   * refused because the blocker would close a loop, and to `null` otherwise.
   */
  readonly add: (change: TaskBlockerChange) => Promise<string | null>;
  /** Takes the blocker away. The undo line says so and offers Undo, which adds it again. */
  readonly remove: (change: TaskBlockerChange) => void;
}

/**
 * Returns the two changes of a Task's blockers for `client`. `moves` puts the
 * gesture on the undo stack and says what happened on the undo line, and
 * `scope` says whether the user who made a change is still signed in.
 */
export const useTaskBlockers = ({
  client,
  scope,
  moves,
}: {
  readonly client: HerculeClient;
  readonly scope: AccountScope;
  readonly moves: Pick<CardMoves, "reserveGesture" | "sayWithReservedUndo" | "sayWithoutUndo">;
}): TaskBlockers => {
  const queryClient = useQueryClient();
  const run = useUndoableTaskChanges({ scope, moves, queueId: "task-blockers" });

  const change = (
    { taskId, taskTitle, blockerId, blockerTitle }: TaskBlockerChange,
    direction: BlockerDirection,
  ): Promise<unknown> => {
    const sendDirection = (toward: BlockerDirection) => (): Promise<TaskChangeAnswer> =>
      toward === "add"
        ? client.task.addBlocker({
            params: { id: taskId },
            payload: { blockedByTaskId: blockerId },
          })
        : client.task.removeBlocker({ params: { id: taskId, blockedByTaskId: blockerId } });
    return run({
      key: `${direction} ${taskId} ${blockerId}`,
      taskId,
      send: sendDirection(direction),
      sendBack: sendDirection(reverseBlockerDirection(direction)),
      readAgain: () => {
        invalidateWithoutCancelling(queryClient, queryKeys.workBoard());
        invalidateWithoutCancelling(queryClient, queryKeys.taskDetail(taskId));
        // The other end lists this Task too, in its own Blocks or Blocked by.
        invalidateWithoutCancelling(queryClient, queryKeys.taskDetail(blockerId));
      },
      words: {
        gesture: describeBlockerGesture(direction, taskTitle, blockerTitle),
        done: describeBlockerDone(direction, taskTitle, blockerTitle),
        nothing: describeBlockerNothing(direction, taskTitle, blockerTitle),
        failed: (error) =>
          isBlockerCycle(error)
            ? describeBlockerLoopRefused(taskTitle, blockerTitle)
            : describeBlockerFailure(direction, taskTitle, blockerTitle, readReason(error)),
      },
    });
  };

  return {
    add: async (blockerChange) => {
      const refusal = await change(blockerChange, "add");
      return isBlockerCycle(refusal) ? readErrorMessage(refusal) : null;
    },
    remove: (blockerChange) => {
      void change(blockerChange, "remove");
    },
  };
};
