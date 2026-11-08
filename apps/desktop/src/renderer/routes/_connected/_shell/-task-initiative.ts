/**
 * Putting a Task on an Initiative and taking it off, from the details pane
 * (`task.update` with `initiativeId`; `null` takes it off). Each change is one
 * gesture with an Undo, sent the way `useUndoableTaskChanges` sends every
 * change of a Task. An Undo puts the Task back on the Initiative it was on
 * (or on none). A change away from a closed Initiative has no Undo, because
 * the controller refuses to put a Task back on a closed Initiative.
 *
 * Picks for one Task are not stacked. From the pick until the answer has
 * been read again (and the same for an Undo), the Task counts as changing
 * (`PendingInitiative`): the pane disables its Initiative menu and shows the
 * chosen Initiative as pending. So every pick reads the Initiative it leaves
 * from a pane that shows the settled answer, and Undo puts back what was
 * really there.
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

/** The longest the pane waits for the board to be read again after a change, in milliseconds. */
const READ_AGAIN_LIMIT_MS = 5000;

/**
 * Returns a promise that resolves once the active board and details reads
 * under `keys` are not running, or after `READ_AGAIN_LIMIT_MS`. It never
 * rejects. The check runs one tick after the last change of the query cache,
 * because a read that finished after the change was made starts another one
 * right away.
 */
const waitForReads = (
  queryClient: QueryClient,
  keys: readonly (readonly unknown[])[],
): Promise<void> =>
  new Promise((resolve) => {
    const cache = queryClient.getQueryCache();
    let check: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = (): void => undefined;
    const finish = (): void => {
      unsubscribe();
      clearTimeout(check);
      clearTimeout(limit);
      resolve();
    };
    const isReading = (): boolean =>
      keys.some((queryKey) =>
        cache
          .findAll({ queryKey, type: "active" })
          .some((query) => query.state.fetchStatus === "fetching"),
      );
    const checkSoon = (): void => {
      clearTimeout(check);
      check = setTimeout(() => {
        if (!isReading()) finish();
      }, 0);
    };
    const limit = setTimeout(finish, READ_AGAIN_LIMIT_MS);
    unsubscribe = cache.subscribe(checkSoon);
    checkSoon();
  });

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
      await client.task.update({ params: { id: taskId }, payload: { initiativeId } });
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
          return waitForReads(queryClient, [queryKeys.workBoard(), queryKeys.taskDetail(taskId)]);
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
