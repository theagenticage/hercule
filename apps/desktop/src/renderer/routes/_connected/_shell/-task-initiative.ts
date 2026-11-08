/**
 * Putting a Task on an Initiative and taking it off, from the details pane
 * (`task.update` with `initiativeId`; `null` takes it off). Each change is one
 * gesture with an Undo, sent the way `useUndoableTaskChanges` sends every
 * change of a Task. An Undo puts the Task back on the Initiative it was on
 * (or on none). A change away from a closed Initiative has no Undo, because
 * the controller refuses to put a Task back on a closed Initiative.
 *
 * Picks are sent in order, so the Initiative a pick leaves is the one the
 * pick before it put the Task on, even when that answer has not arrived and
 * the pane still shows the older one (`queuedInitiatives`).
 *
 * The controller refuses an Initiative that was closed since the pane listed
 * it (`InvalidState`) and one that is gone (`NotFound`). The undo line says
 * why, with the controller's words.
 */
import { useRef } from "react";
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
  /**
   * The Initiative the pane shows the Task on, which Undo puts it back on.
   * `undefined` when it is on none. Ignored while an earlier pick on the same
   * Task has not been answered: that pick's Initiative is the one left.
   */
  readonly fromInitiativeId: string | undefined;
  /** False when Initiative `fromInitiativeId` is closed, so nothing can put the Task back on it. */
  readonly canPutBack: boolean;
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
  // For each Task with picks in the queue: how many, and the Initiative the
  // last of them puts it on. Read only when the user picks.
  const queuedInitiatives = useRef(
    new Map<string, { readonly picks: number; readonly initiativeId: string | undefined }>(),
  );

  return ({ taskId, taskTitle, fromInitiativeId, canPutBack, to }) => {
    const queued = queuedInitiatives.current.get(taskId);
    const from = queued === undefined ? fromInitiativeId : queued.initiativeId;
    const isPutBack = queued !== undefined || canPutBack;
    queuedInitiatives.current.set(taskId, {
      picks: (queued?.picks ?? 0) + 1,
      initiativeId: to?.id,
    });
    const write = (initiativeId: string | null) => async () => {
      await client.task.update({ params: { id: taskId }, payload: { initiativeId } });
      return { changed: true };
    };
    const name = to?.name ?? null;
    const wasClosed = !isPutBack;
    void run({
      key: `initiative ${taskId} ${to?.id ?? "none"}`,
      taskId,
      send: write(to?.id ?? null),
      sendBack: isPutBack ? write(from ?? null) : null,
      readAgain: () => {
        invalidateWithoutCancelling(queryClient, queryKeys.workBoard());
        invalidateWithoutCancelling(queryClient, queryKeys.taskDetail(taskId));
      },
      words: {
        gesture: describeInitiativeGesture(taskTitle, name, wasClosed),
        done: describeInitiativeDone(taskTitle, name, wasClosed),
        // An update has no "nothing to do": the pane never sends the Initiative the Task is on.
        nothing: describeInitiativeDone(taskTitle, name, wasClosed),
        failed: (error) => describeInitiativeFailure(taskTitle, name, wasClosed, readReason(error)),
      },
    }).then(() => {
      const left = queuedInitiatives.current.get(taskId);
      if (left === undefined) return;
      if (left.picks <= 1) queuedInitiatives.current.delete(taskId);
      else queuedInitiatives.current.set(taskId, { ...left, picks: left.picks - 1 });
    });
  };
};
