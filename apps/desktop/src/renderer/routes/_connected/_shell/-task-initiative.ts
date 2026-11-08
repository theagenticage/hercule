/**
 * Putting a Task on an Initiative and taking it off, from the details pane
 * (`task.update` with `initiativeId`; `null` takes it off). Each change is one
 * gesture with an Undo, sent the way `useUndoableTaskChanges` sends every
 * change of a Task. An Undo puts the Task back on the Initiative it was on
 * (or on none).
 *
 * The controller refuses an Initiative that was closed since the pane listed
 * it (`InvalidState`) and one that is gone (`NotFound`). The undo line says
 * why, with the controller's words.
 */
import { useQueryClient } from "@tanstack/react-query";
import { invalidateWithoutCancelling, queryKeys, type HerculeClient } from "@hercule/client-core";
import {
  describeInitiativeDone,
  describeInitiativeFailure,
  describeInitiativeGesture,
} from "@hercule/client-core/work";
import type { AccountScope } from "../../../app/account-scope";
import { readReason } from "../../../app/read-reason";
import type { CardMoves } from "./-card-moves";
import { useUndoableTaskChanges } from "./-undoable-task-change";

/** The Task that changes Initiative, and the Initiative it was on and goes to. */
export interface TaskInitiativeChange {
  readonly taskId: string;
  readonly taskTitle: string;
  /** The Initiative the Task is on now, which Undo puts it back on. `undefined` when it is on none. */
  readonly fromInitiativeId: string | undefined;
  /** The Initiative to put the Task on: its id and name, or `null` to take it off. */
  readonly to: { readonly id: string; readonly name: string } | null;
}

/**
 * Returns the function that puts a Task on an Initiative, or takes it off.
 * `moves` puts the gesture on the undo stack and says what happened on the
 * undo line, and `scope` says whether the user who made the change is still
 * signed in.
 */
export const useTaskInitiative = ({
  client,
  scope,
  moves,
}: {
  readonly client: HerculeClient;
  readonly scope: AccountScope;
  readonly moves: Pick<CardMoves, "reserveGesture" | "sayWithReservedUndo" | "sayWithoutUndo">;
}): ((change: TaskInitiativeChange) => void) => {
  const queryClient = useQueryClient();
  const run = useUndoableTaskChanges({ scope, moves, queueId: "task-initiative" });

  return ({ taskId, taskTitle, fromInitiativeId, to }) => {
    const write = (initiativeId: string | null) => async () => {
      await client.task.update({ params: { id: taskId }, payload: { initiativeId } });
      return { changed: true };
    };
    const name = to?.name ?? null;
    void run({
      key: `initiative ${taskId} ${to?.id ?? "none"}`,
      taskId,
      send: write(to?.id ?? null),
      sendBack: write(fromInitiativeId ?? null),
      readAgain: () => {
        invalidateWithoutCancelling(queryClient, queryKeys.workBoard());
        invalidateWithoutCancelling(queryClient, queryKeys.taskDetail(taskId));
      },
      words: {
        gesture: describeInitiativeGesture(taskTitle, name),
        done: describeInitiativeDone(taskTitle, name),
        // An update has no "nothing to do": the pane never sends the Initiative the Task is on.
        nothing: describeInitiativeDone(taskTitle, name),
        failed: (error) => describeInitiativeFailure(taskTitle, name, readReason(error)),
      },
    });
  };
};
