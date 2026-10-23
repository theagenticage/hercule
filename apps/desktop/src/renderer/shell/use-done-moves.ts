/**
 * Marking a thread done from the sidebar, and reopening it (spec 17
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
import type { DoneToastStore } from "./done-toast";

/** A move on a thread's Done state: mark it Done, or reopen it. */
type DoneMove = "markDone" | "reopen";

/**
 * Returns the thread list with the session `sessionId` replaced by what
 * `update` returns for it. The list is unchanged when it does not hold the
 * session.
 */
const replaceThread = (
  threads: readonly Session[],
  sessionId: string,
  update: (session: Session) => Session,
): readonly Session[] =>
  threads.map((session) => (session.id === sessionId ? update(session) : session));

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
 * `toasts`.
 *
 * - `markDone(sessionId)` takes the thread off its project at once, before
 *   the controller answers, and shows "Marked done" with Undo in the toast.
 * - `reopen(sessionId)` puts the thread back in its project at once. Undo in
 *   the toast and Reopen on the Done shelf both call it.
 * - A move that fails reads the thread list again, so the row goes back to
 *   where the controller has it, and shows the error in the toast as an
 *   alert.
 *
 * The moves are sent one at a time, in the order the user made them, so a
 * quick Undo always reaches the controller after the Done it undoes. While a
 * later move is still pending, a move's answer is not written to the list:
 * the list already shows the later move, and the answer would briefly put
 * the row back where the user just moved it from. The last move to finish
 * reads the list again.
 *
 * `markDone` and `reopen` keep their identity across renders, so the
 * memoized rows that take them do not draw again.
 */
export const useDoneMoves = (
  client: HerculeClient,
  toasts: DoneToastStore,
): {
  readonly markDone: (sessionId: string) => void;
  readonly reopen: (sessionId: string) => void;
} => {
  const queryClient = useQueryClient();

  const { mutate } = useMutation({
    mutationKey: DONE_MOVES_KEY,
    scope: { id: "done-moves" },
    mutationFn: ({ sessionId, move }: { sessionId: string; move: DoneMove }) =>
      move === "markDone"
        ? client.session.markDone({ payload: { sessionIds: [sessionId] } })
        : client.session.reopen({ payload: { sessionIds: [sessionId] } }),
    // A move in a scope waits for the one before it to finish before it is
    // sent, but its `onMutate` runs at once, so the list follows the user.
    onMutate: async ({ sessionId, move }) => {
      // A read that started before the move would answer without it and
      // put the row back, so it is cancelled; the last move reads again.
      await queryClient.cancelQueries({ queryKey: threadAndAgentSessionsQuery(client).queryKey });
      const at = new Date().toISOString();
      queryClient.setQueryData(
        threadAndAgentSessionsQuery(client).queryKey,
        (threads) =>
          threads && replaceThread(threads, sessionId, (s) => applyDoneMove(s, move, at)),
      );
      if (move === "markDone") toasts.show(sessionId, "Marked done", false);
    },
    onSuccess: (moved) => {
      if (!isLastDoneMove(queryClient)) return;
      queryClient.setQueryData(
        threadAndAgentSessionsQuery(client).queryKey,
        (threads) =>
          threads &&
          moved.reduce((rest, session) => replaceThread(rest, session.id, () => session), threads),
      );
      readThreadsAgain(queryClient, client);
    },
    onError: (error, { sessionId, move }) => {
      if (isLastDoneMove(queryClient)) readThreadsAgain(queryClient, client);
      const what = move === "markDone" ? "mark the thread done" : "reopen the thread";
      toasts.show(sessionId, `Couldn't ${what}: ${readErrorMessage(error)}`, true);
    },
  });

  const markDone = useCallback(
    (sessionId: string) => {
      mutate({ sessionId, move: "markDone" });
    },
    [mutate],
  );
  const reopen = useCallback(
    (sessionId: string) => {
      mutate({ sessionId, move: "reopen" });
    },
    [mutate],
  );
  return { markDone, reopen };
};
