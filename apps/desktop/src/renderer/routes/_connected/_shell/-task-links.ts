/**
 * Linking a thing to a Task by hand and removing a link, from the details
 * pane (`task.linkEntity`, `task.unlinkEntity`). Each change is one gesture
 * with an Undo, sent the way `useUndoableTaskChanges` sends every change of a
 * Task. An Undo of a link removes it, and an Undo of a removal links it again.
 * A removed link stays removed, which the line says, because the user may
 * expect the next scan of the source to bring it back.
 */
import { useQueryClient } from "@tanstack/react-query";
import { invalidateWithoutCancelling, queryKeys, type HerculeClient } from "@hercule/client-core";
import { reverseLinkDirection, type LinkDirection } from "@hercule/client-core/desk";
import {
  describeTaskLinkDone,
  describeTaskLinkFailure,
  describeTaskLinkGesture,
  describeTaskLinkNothing,
} from "@hercule/client-core/work";
import type { AccountScope } from "../../../app/account-scope";
import { readReason } from "../../../app/read-reason";
import type { CardMoves } from "./-card-moves";
import { useUndoableTaskChanges, type TaskChangeAnswer } from "./-undoable-task-change";

/** The Task a link changes on, and the thing at its other end, as the undo line names them. */
export interface TaskLinkChange {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly ref: string;
  /** How a sentence names the thing: its identifier ("#412") or else its title. */
  readonly thingName: string;
}

/** What `useTaskLinks` returns. */
export interface TaskLinks {
  /** Links `change.ref` to the Task. The undo line says so and offers Undo, which removes it. */
  readonly link: (change: TaskLinkChange) => void;
  /** Removes the link. The undo line says so and offers Undo, which links it again. */
  readonly unlink: (change: TaskLinkChange) => void;
}

/**
 * Returns the two changes of a Task's links for `client`. `moves` puts the
 * gesture on the undo stack and says what happened on the undo line, and
 * `scope` says whether the user who made a change is still signed in.
 */
export const useTaskLinks = ({
  client,
  scope,
  moves,
}: {
  readonly client: HerculeClient;
  readonly scope: AccountScope;
  readonly moves: Pick<CardMoves, "reserveGesture" | "sayWithReservedUndo" | "sayWithoutUndo">;
}): TaskLinks => {
  const queryClient = useQueryClient();
  const run = useUndoableTaskChanges({ scope, moves, queueId: "task-links" });

  const change = (
    { taskId, taskTitle, ref, thingName: name }: TaskLinkChange,
    direction: LinkDirection,
  ): void => {
    const sendDirection = (toward: LinkDirection) => (): Promise<TaskChangeAnswer> => {
      const input = { params: { id: taskId }, payload: { ref } };
      return toward === "link" ? client.task.linkEntity(input) : client.task.unlinkEntity(input);
    };
    void run({
      key: `${direction} ${taskId} ${ref}`,
      taskId,
      send: sendDirection(direction),
      sendBack: sendDirection(reverseLinkDirection(direction)),
      readAgain: () => {
        invalidateWithoutCancelling(queryClient, queryKeys.workBoard());
        invalidateWithoutCancelling(queryClient, queryKeys.taskDetail(taskId));
      },
      words: {
        gesture: describeTaskLinkGesture(direction, name, taskTitle),
        done: describeTaskLinkDone(direction, name, taskTitle),
        nothing: describeTaskLinkNothing(direction, name, taskTitle),
        failed: (error) => describeTaskLinkFailure(direction, name, taskTitle, readReason(error)),
      },
    });
  };

  return {
    link: (linkChange) => {
      change(linkChange, "link");
    },
    unlink: (linkChange) => {
      change(linkChange, "unlink");
    },
  };
};
