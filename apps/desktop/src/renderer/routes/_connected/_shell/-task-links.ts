/**
 * Linking a thing to a Task by hand and removing a link, from the details
 * pane (`task.linkEntity`, `task.unlinkEntity`).
 *
 * - Each change is one gesture on the undo stack, and its words are on the
 *   undo line, both taken when the user acts and while the request is still
 *   running. The line belongs to that moment and not to the order in which
 *   answers come, so a slow answer never takes the line from a gesture the
 *   user made after it. Its Undo is the change the other way: an Undo of a
 *   link removes it, and an Undo of a removal links it again.
 * - Every request and every reversal runs in one queue (the mutation scope),
 *   so a gesture made after Undo is sent after it.
 * - The controller says whether a call changed anything. A call that changed
 *   nothing (the thing was linked already, or never linked) takes its gesture
 *   off the stack again, and the line says so. A reversal is sent only when
 *   the gesture it reverses changed something, so Undo never makes a change
 *   the user did not ask for.
 * - The same change of the same thing is not sent again while the first is on
 *   its way, so a double press cannot queue a second one.
 * - A refusal takes the gesture off the stack and the line says why. Nothing
 *   is queued for later when the controller cannot be reached: the line says
 *   the change was not made, and the user tries again.
 */
import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invalidateWithoutCancelling, queryKeys, type HerculeClient } from "@hercule/client-core";
import {
  describeTaskLinkDone,
  describeTaskLinkFailure,
  describeTaskLinkGesture,
  describeTaskLinkNothing,
  reverseTaskLinkDirection,
  type TaskLinkDirection,
} from "@hercule/client-core/work";
import { requireSignedIn, type AccountScope } from "../../../app/account-scope";
import type { CardMover } from "../../../app/card-mover";
import { readReason } from "../../../app/read-reason";
import type { Gesture } from "../../../app/undo-stack";
import type { CardMoves } from "./-card-moves";

/** The key every link change runs under, so they wait for one another. */
const TASK_LINKS_KEY = ["task-links"];

const NOTHING_TO_PUT_BACK = "That change was not made, so there is nothing to put back.";

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
  // The changes on their way, by direction, Task and thing: a second one of the same waits for nobody.
  const onItsWay = useRef(new Set<string>());

  const request = useMutation({
    mutationKey: TASK_LINKS_KEY,
    scope: { id: "task-links" },
    mutationFn: async ({
      taskId,
      ref,
      direction,
      isWanted,
    }: {
      readonly taskId: string;
      readonly ref: string;
      readonly direction: TaskLinkDirection;
      /** For a reversal: resolves to whether the change it reverses was made. */
      readonly isWanted: Promise<boolean> | undefined;
    }) => {
      // Checked when the request reaches the front of the queue, so a change that was refused is never reversed.
      requireSignedIn(scope);
      if (isWanted !== undefined && !(await isWanted)) throw new Error(NOTHING_TO_PUT_BACK);
      requireSignedIn(scope);
      const input = { params: { id: taskId }, payload: { ref } };
      return direction === "link" ? client.task.linkEntity(input) : client.task.unlinkEntity(input);
    },
  });

  const readAgain = (taskId: string): void => {
    invalidateWithoutCancelling(queryClient, queryKeys.workBoard());
    invalidateWithoutCancelling(queryClient, queryKeys.taskDetail(taskId));
  };

  const change = (
    { taskId, taskTitle, ref, thingName: name }: TaskLinkChange,
    direction: TaskLinkDirection,
  ): void => {
    const key = `${direction} ${taskId} ${ref}`;
    if (onItsWay.current.has(key)) return;
    onItsWay.current.add(key);
    const answered = request.mutateAsync({ taskId, ref, direction, isWanted: undefined });
    const wasChanged = answered.then(
      ({ changed }) => changed,
      () => false,
    );
    void wasChanged.then(() => {
      onItsWay.current.delete(key);
    });
    const gesture: Gesture<CardMover> = {
      words: describeTaskLinkGesture(direction, name, taskTitle),
      undo: async () => {
        await request.mutateAsync({
          taskId,
          ref,
          direction: reverseTaskLinkDirection(direction),
          isWanted: wasChanged,
        });
        if (scope.isCurrent()) readAgain(taskId);
        return undefined;
      },
    };
    moves.reserveGesture(gesture, wasChanged);
    moves.sayWithReservedUndo(describeTaskLinkDone(direction, name, taskTitle), gesture);
    answered.then(
      ({ changed }) => {
        if (!scope.isCurrent()) return;
        readAgain(taskId);
        if (!changed) moves.sayWithoutUndo(describeTaskLinkNothing(direction, name, taskTitle));
      },
      (error: unknown) => {
        if (!scope.isCurrent()) return;
        moves.sayWithoutUndo(
          describeTaskLinkFailure(direction, name, taskTitle, readReason(error)),
        );
      },
    );
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
