/**
 * Marking threads done from the sidebar, and reopening them (spec 17
 * §Sidebar, the Done shelf).
 */
import { useCallback, useRef } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  invalidateWithoutCancelling,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import type { Session } from "@hercule/contract";
import { sessionQuery, threadAndAgentSessionsQuery } from "../app/queries";
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

/**
 * Reads the thread list, and the record of each of `sessionIds` that is
 * cached, again, without cancelling a read that is running.
 */
const readThreadsAgain = (
  queryClient: QueryClient,
  client: HerculeClient,
  sessionIds: Iterable<string>,
): void => {
  invalidateWithoutCancelling(queryClient, threadAndAgentSessionsQuery(client).queryKey);
  for (const id of sessionIds) {
    invalidateWithoutCancelling(queryClient, sessionQuery(client, id).queryKey);
  }
};

/**
 * Replaces each of `sessionIds` with what `update` returns for it, in the
 * cached thread list and in the session's own cached record. A session with
 * no cached record is left alone, in both places. The sidebar draws an open
 * Done Thread that is too old for its list from such a record.
 */
const updateCachedSessions = (
  queryClient: QueryClient,
  client: HerculeClient,
  sessionIds: readonly string[],
  update: (session: Session) => Session,
): void => {
  const moved = new Set(sessionIds);
  queryClient.setQueryData(threadAndAgentSessionsQuery(client).queryKey, (sessions) =>
    sessions?.map((session) => (moved.has(session.id) ? update(session) : session)),
  );
  for (const id of sessionIds) {
    queryClient.setQueryData(sessionQuery(client, id).queryKey, (cached) =>
      cached === undefined ? undefined : update(cached),
    );
  }
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
 *   alert. While the toast shows the Undo of a newer move, the error waits
 *   until that toast goes, so a failure never takes away an Undo that still
 *   works.
 * - The record of a moved Thread that the sidebar holds on its own, because
 *   the Thread is too old for the list, follows the move and the answer the
 *   same way the list does.
 *
 * The moves are sent one at a time, in the order the user made them, so a
 * quick Undo always reaches the controller after the Done it undoes. While a
 * later move is still pending, a move's answer is not written to the list:
 * the list already shows the later move, and the answer would briefly put
 * the rows back where the user just moved them from. The last move to finish
 * reads the list, and the Threads moved since the last read, again.
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
  // The Threads moved since the last time no move was pending. The last move
  // to finish reads their records again.
  const movedSinceRead = useRef(new Set<string>());

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
      // A Thread's own record is cancelled only when it is cached. A first
      // read still running has nothing to put back, and cancelling it would
      // fail the screen that waits for it.
      for (const id of sessionIds) movedSinceRead.current.add(id);
      const cachedIds = sessionIds.filter(
        (id) => queryClient.getQueryData(sessionQuery(client, id).queryKey) !== undefined,
      );
      await Promise.all([
        queryClient.cancelQueries({ queryKey: threadAndAgentSessionsQuery(client).queryKey }),
        ...cachedIds.map((id) =>
          queryClient.cancelQueries({ queryKey: sessionQuery(client, id).queryKey }),
        ),
      ]);
      const at = new Date().toISOString();
      updateCachedSessions(queryClient, client, sessionIds, (session) =>
        applyDoneMove(session, move, at),
      );
      if (!announce) return { toastSerial: null };
      const text = describeDoneMove(move, sessionIds.length, false);
      return { toastSerial: toasts.show(text, { move: reverseDoneMove(move), sessionIds }) };
    },
    onSuccess: (answered, { sessionIds }) => {
      if (!isLastDoneMove(queryClient)) return;
      const answers = new Map(answered.map((session) => [session.id, session]));
      updateCachedSessions(
        queryClient,
        client,
        sessionIds,
        (session) => answers.get(session.id) ?? session,
      );
    },
    onError: (error, { sessionIds, move }, context) => {
      const text = describeDoneMove(move, sessionIds.length, true);
      toasts.showFailure(`${text}: ${readErrorMessage(error)}`, context?.toastSerial ?? null);
    },
    // Runs after the answer or the error, for a move that succeeded and for
    // one that failed alike.
    onSettled: () => {
      if (!isLastDoneMove(queryClient)) return;
      readThreadsAgain(queryClient, client, movedSinceRead.current);
      movedSinceRead.current.clear();
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
