/**
 * Marking threads done from the sidebar, and reopening them (spec 17
 * §Sidebar, the Done shelf).
 */
import { useCallback } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  invalidateWithoutCancelling,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import type { Session } from "@hercule/contract";
import { threadAndAgentSessionsQuery } from "../app/queries";
import type { DoneMove, DoneToastStore, DoneUndo } from "./done-toast";

/**
 * Returns the session as it is once `move` has been applied at `at`: done
 * since `at`, or reopened at `at` with no `done`. The controller's answer
 * replaces this guess, so only the fields the sidebar sorts and filters on
 * are set.
 */
const applyDoneMove = (session: Session, move: DoneMove, at: string): Session => {
  if (move === "markDone") return { ...session, done: { at, by: "user" } };
  const { done, ...open } = session;
  void done;
  return { ...open, reopenedAt: at };
};

/**
 * Returns the toast text for a move on `count` threads. A move that worked
 * reads "Marked done", "Marked 3 done", "Reopened" or "Reopened 3"; one that
 * failed reads "Couldn't mark the thread done" or "Couldn't reopen 3 threads".
 */
const describeDoneMove = (move: DoneMove, count: number, failed: boolean): string => {
  if (failed) {
    const threads = count === 1 ? "the thread" : `${String(count)} threads`;
    return move === "markDone" ? `Couldn't mark ${threads} done` : `Couldn't reopen ${threads}`;
  }
  if (move === "markDone") return count === 1 ? "Marked done" : `Marked ${String(count)} done`;
  return count === 1 ? "Reopened" : `Reopened ${String(count)}`;
};

/**
 * One Done move on a list of threads. `announce` says whether it shows a
 * toast: the user's own moves do, an Undo does not.
 */
interface DoneRequest {
  readonly sessionIds: readonly string[];
  readonly move: DoneMove;
  readonly announce: boolean;
}

/** Returns the move that reverses `move`. */
const reverseDoneMove = (move: DoneMove): DoneMove => (move === "markDone" ? "reopen" : "markDone");

/** Reads the thread list again, without cancelling a read that is running. */
const readThreadsAgain = (queryClient: QueryClient, client: HerculeClient): void => {
  invalidateWithoutCancelling(queryClient, threadAndAgentSessionsQuery(client).queryKey);
};

/** The key every Done move runs under, so the moves can be counted. */
const DONE_MOVES_KEY = ["done-moves"];

/**
 * Checks that no Done move but the one finishing is still waiting or running.
 * A move is pending until its callbacks have run, so the one finishing
 * counts as one.
 */
const isLastDoneMove = (queryClient: QueryClient): boolean =>
  queryClient.isMutating({ mutationKey: DONE_MOVES_KEY }) === 1;

/**
 * Runs the sidebar's Done moves for `client`, and shows their toasts in
 * `toasts`. A move takes a list of thread ids and is one request, applied by
 * the controller all or nothing.
 *
 * - `markDone(sessionIds)` takes the threads off their projects at once,
 *   before the controller answers, and shows "Marked done" (or "Marked 3
 *   done") with Undo in the toast.
 * - `reopen(sessionIds)` puts the threads back in their projects at once and
 *   shows "Reopened" (or "Reopened 3") with Undo. Reopen on the Done shelf
 *   calls it.
 * - `undo(undo)` makes the move of a toast's Undo on exactly the threads of
 *   that toast. It shows no toast of its own.
 * - A move that fails reads the thread list again, so the rows go back to
 *   where the controller has them, and shows the error in the toast as an
 *   alert.
 *
 * The moves are sent one at a time, in the order the user made them, so a
 * quick Undo always reaches the controller after the Done it undoes. While a
 * later move is still pending, a move's answer is not written to the list:
 * the list already shows the later move, and the answer would briefly put
 * the rows back where the user just moved them from. The last move to finish
 * reads the list again.
 *
 * The three functions keep their identity across renders, so the memoized
 * rows that take them do not draw again.
 */
export const useDoneMoves = (
  client: HerculeClient,
  toasts: DoneToastStore,
): {
  readonly markDone: (sessionIds: readonly string[]) => void;
  readonly reopen: (sessionIds: readonly string[]) => void;
  readonly undo: (undo: DoneUndo) => void;
} => {
  const queryClient = useQueryClient();

  const { mutate } = useMutation({
    mutationKey: DONE_MOVES_KEY,
    scope: { id: "done-moves" },
    mutationFn: ({ sessionIds, move }: DoneRequest) =>
      move === "markDone"
        ? client.session.markDone({ payload: { sessionIds } })
        : client.session.reopen({ payload: { sessionIds } }),
    // A move in a scope waits for the one before it to finish before it is
    // sent, but its `onMutate` runs at once, so the list follows the user.
    onMutate: async ({ sessionIds, move, announce }) => {
      // A read that started before the move would answer without it and
      // put the rows back, so it is cancelled; the last move reads again.
      await queryClient.cancelQueries({ queryKey: threadAndAgentSessionsQuery(client).queryKey });
      const at = new Date().toISOString();
      const moved = new Set(sessionIds);
      queryClient.setQueryData(threadAndAgentSessionsQuery(client).queryKey, (sessions) =>
        sessions?.map((session) =>
          moved.has(session.id) ? applyDoneMove(session, move, at) : session,
        ),
      );
      if (announce) {
        const text = describeDoneMove(move, sessionIds.length, false);
        toasts.show(text, false, { move: reverseDoneMove(move), sessionIds });
      }
    },
    onSuccess: (answered) => {
      if (!isLastDoneMove(queryClient)) return;
      const answers = new Map(answered.map((session) => [session.id, session]));
      queryClient.setQueryData(threadAndAgentSessionsQuery(client).queryKey, (sessions) =>
        sessions?.map((session) => answers.get(session.id) ?? session),
      );
      readThreadsAgain(queryClient, client);
    },
    onError: (error, { sessionIds, move }) => {
      if (isLastDoneMove(queryClient)) readThreadsAgain(queryClient, client);
      const text = describeDoneMove(move, sessionIds.length, true);
      toasts.show(`${text}: ${readErrorMessage(error)}`, true, null);
    },
  });

  const markDone = useCallback(
    (sessionIds: readonly string[]) => {
      mutate({ sessionIds, move: "markDone", announce: true });
    },
    [mutate],
  );
  const reopen = useCallback(
    (sessionIds: readonly string[]) => {
      mutate({ sessionIds, move: "reopen", announce: true });
    },
    [mutate],
  );
  const undo = useCallback(
    ({ move, sessionIds }: DoneUndo) => {
      mutate({ sessionIds, move, announce: false });
    },
    [mutate],
  );
  return { markDone, reopen, undo };
};
