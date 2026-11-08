/**
 * Linking a thing to a Task by hand and removing a link, from the details
 * pane (`task.linkEntity`, `task.unlinkEntity`).
 *
 * - Each change is one gesture on the undo stack, taken when the user acts and
 *   while the request is still running. Its Undo is the change the other way:
 *   an Undo of a link removes it, and an Undo of a removal links it again.
 * - Every request and every reversal runs in one queue (the mutation scope),
 *   so a gesture made after Undo is sent after it.
 * - A reversal is sent only when the gesture it reverses was accepted. The
 *   controller does not say whether a call changed anything, because both
 *   calls leave things as they are when there is nothing to do, so an
 *   accepted call counts as a change.
 * - The undo line says what happened. A refusal says why, with no Undo.
 *   Nothing is queued for later when the controller cannot be reached: the
 *   line says the change was not made, and the user tries again.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  invalidateWithoutCancelling,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import {
  describeTaskLinkDone,
  describeTaskLinkFailure,
  describeTaskLinkGesture,
  reverseTaskLinkDirection,
  type TaskLinkDirection,
} from "@hercule/client-core/work";
import type { AccountScope } from "../../../app/account-scope";
import type { CardMover } from "../../../app/card-mover";
import type { Gesture } from "../../../app/undo-stack";
import type { CardMoves } from "./-card-moves";

/** The key every link change runs under, so they wait for one another. */
const TASK_LINKS_KEY = ["task-links"];

const SIGNED_OUT = "You signed out before this was sent.";

const NOTHING_TO_PUT_BACK = "That change was not made, so there is nothing to put back.";

/** Removes the full stops at the end of an error's words, so a sentence can go on after them. */
const readReason = (error: unknown): string => readErrorMessage(error).replace(/\.+$/, "");

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
  const requireSignedIn = (): void => {
    if (!scope.isCurrent()) throw new Error(SIGNED_OUT);
  };

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
      requireSignedIn();
      if (isWanted !== undefined && !(await isWanted)) throw new Error(NOTHING_TO_PUT_BACK);
      requireSignedIn();
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
    const answered = request.mutateAsync({ taskId, ref, direction, isWanted: undefined });
    const wasChanged = answered.then(
      () => true,
      () => false,
    );
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
    answered.then(
      () => {
        if (!scope.isCurrent()) return;
        readAgain(taskId);
        moves.sayWithReservedUndo(describeTaskLinkDone(direction, name, taskTitle), gesture);
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
