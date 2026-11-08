/**
 * Putting a Task on an Initiative and taking it off, from the details pane
 * (`task.update` with `initiativeId`; `null` takes it off). Each change is one
 * gesture with an Undo, sent the way `useUndoableTaskChanges` sends every
 * change of a Task. An Undo puts the Task back on the Initiative it was on
 * (or on none). A change away from a closed Initiative has no Undo, because
 * the controller refuses to put a Task back on a closed Initiative.
 *
 * Picks for one Task are not stacked. From the pick until the controller
 * answers (and the same for an Undo), the Task counts as changing
 * (`PendingInitiative`): the pane disables its Initiative menu and shows the
 * chosen Initiative as pending. The answer is written into the cached details
 * and board at once, whether or not reading them again works, so every pick
 * reads the Initiative it leaves from a pane that shows the confirmed answer,
 * and Undo puts back what was really there. A refused change writes nothing.
 *
 * The controller refuses an Initiative that was closed since the pane listed
 * it (`InvalidState`) and one that is gone (`NotFound`). The undo line says
 * why, with the controller's words.
 */
import { useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { invalidateWithoutCancelling, queryKeys, type HerculeClient } from "@hercule/client-core";
import {
  describeInitiativeDone,
  describeInitiativeFailure,
  describeInitiativeGesture,
} from "@hercule/client-core/work";
import type { AccountScope } from "../../../app/account-scope";
import type { TaskDetail, WorkBoard } from "@hercule/contract";
import { readReason } from "../../../app/read-reason";
import type { CardMoves } from "./-card-moves";
import { useUndoableTaskChanges } from "./-undoable-task-change";

/** The Task that changes Initiative, and the Initiative it was on and goes to. */
export interface TaskInitiativeChange {
  readonly taskId: string;
  readonly taskTitle: string;
  /** The Initiative the pane shows the Task on, which Undo puts it back on. `undefined` when it is on none. */
  readonly fromInitiativeId: string | undefined;
  /** False when Initiative `fromInitiativeId` is closed, so nothing can put the Task back on it. */
  readonly canPutBack: boolean;
  /** The Initiative to put the Task on: its id and name, or `null` to take it off. */
  readonly to: { readonly id: string; readonly name: string } | null;
}

/** A change of a Task's Initiative (a pick or its Undo) that has not finished, for the pane to show. */
export interface PendingInitiative {
  readonly taskId: string;
  /** The Initiative the Task is going to be on, or `null` for none. */
  readonly initiativeId: string | null;
}

/** Returns `value` with its `initiativeId` set to `initiativeId`, or without one for `null`. */
const withInitiative = <T extends { readonly initiativeId?: string }>(
  value: T,
  initiativeId: string | null,
): T => {
  const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "initiativeId"));
  return (initiativeId === null ? rest : { ...rest, initiativeId }) as T;
};

/**
 * Writes the Initiative the controller answered into the cached details of the
 * Task and into its card on the cached board, so the pane shows the confirmed
 * membership at once, even when reading again fails or is slow. Reads under
 * way are cancelled first: one that began before the answer could end after
 * the write and put the old Initiative back. Nothing is written when the user
 * who made the change has signed out, because the cache then belongs to the
 * next account.
 */
const writeAnsweredInitiative = async (
  queryClient: QueryClient,
  scope: AccountScope,
  taskId: string,
  initiativeId: string | null,
): Promise<void> => {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: queryKeys.workBoard() }),
    queryClient.cancelQueries({ queryKey: queryKeys.taskDetail(taskId) }),
  ]);
  if (!scope.isCurrent()) return;
  queryClient.setQueryData<WorkBoard>(queryKeys.workBoard(), (board) =>
    board === undefined
      ? undefined
      : {
          ...board,
          cards: board.cards.map((card) =>
            card.id === taskId ? withInitiative(card, initiativeId) : card,
          ),
        },
  );
  queryClient.setQueryData<TaskDetail>(queryKeys.taskDetail(taskId), (detail) =>
    detail === undefined
      ? undefined
      : {
          ...detail,
          task: withInitiative(detail.task, initiativeId),
          card: withInitiative(detail.card, initiativeId),
        },
  );
};

/**
 * Returns the function that puts a Task on an Initiative, or takes it off,
 * and the changes that have not finished. `moves` puts the gesture on the undo
 * stack and says what happened on the undo line, and `scope` says whether the
 * user who made the change is still signed in.
 *
 * The function does nothing for a Task that is already changing: the pane
 * does not offer a pick then.
 */
export const useTaskInitiative = ({
  client,
  scope,
  moves,
}: {
  readonly client: HerculeClient;
  readonly scope: AccountScope;
  readonly moves: Pick<CardMoves, "reserveGesture" | "sayWithReservedUndo" | "sayWithoutUndo">;
}): {
  readonly change: (change: TaskInitiativeChange) => void;
  readonly pending: readonly PendingInitiative[];
} => {
  const queryClient = useQueryClient();
  const run = useUndoableTaskChanges({ scope, moves, queueId: "task-initiative" });
  const [pending, setPending] = useState<readonly PendingInitiative[]>([]);

  const track = (entry: PendingInitiative, finished: Promise<unknown>): void => {
    setPending((entries) => [...entries, entry]);
    const forget = (): void => {
      setPending((entries) => entries.filter((each) => each !== entry));
    };
    finished.then(forget, forget);
  };

  const change = ({
    taskId,
    taskTitle,
    fromInitiativeId,
    canPutBack,
    to,
  }: TaskInitiativeChange) => {
    if (pending.some((each) => each.taskId === taskId)) return;
    const write = (initiativeId: string | null) => async () => {
      const answered = await client.task.update({
        params: { id: taskId },
        payload: { initiativeId },
      });
      if (scope.isCurrent()) {
        await writeAnsweredInitiative(queryClient, scope, taskId, answered.initiativeId ?? null);
      }
      return { changed: true };
    };
    const name = to?.name ?? null;
    const wasClosed = !canPutBack;
    track(
      { taskId, initiativeId: to?.id ?? null },
      run({
        key: `initiative ${taskId} ${to?.id ?? "none"}`,
        taskId,
        send: write(to?.id ?? null),
        sendBack: canPutBack ? write(fromInitiativeId ?? null) : null,
        trackUndo: (undoing) => {
          track({ taskId, initiativeId: fromInitiativeId ?? null }, undoing);
        },
        readAgain: () => {
          invalidateWithoutCancelling(queryClient, queryKeys.workBoard());
          invalidateWithoutCancelling(queryClient, queryKeys.taskDetail(taskId));
        },
        words: {
          gesture: describeInitiativeGesture(taskTitle, name, wasClosed),
          done: describeInitiativeDone(taskTitle, name, wasClosed),
          // An update has no "nothing to do": the pane never sends the Initiative the Task is on.
          nothing: describeInitiativeDone(taskTitle, name, wasClosed),
          failed: (error) =>
            describeInitiativeFailure(taskTitle, name, wasClosed, readReason(error)),
        },
      }),
    );
  };

  return { change, pending };
};
