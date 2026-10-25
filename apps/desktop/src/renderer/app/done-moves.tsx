/**
 * Marking threads done, and reopening them (spec 17 §Sidebar, the Done
 * shelf, the thread header). The sidebar and the thread screen share one
 * move queue and one toast, offered by `DoneMovesProvider`.
 */
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { matchQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  invalidateWithoutCancelling,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import type { Session } from "@hercule/contract";
import {
  createDoneToastStore,
  type DoneMove,
  type DoneToastStore,
  type DoneUndo,
} from "./done-toast-store";
import { sessionQuery, threadAndAgentSessionsQuery } from "./queries";

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
 * Cancels the running reads of the thread list and of the record of each of
 * `sessionIds`, and returns when they have stopped. A query that holds no
 * data yet is left alone: nothing in it can be put back, and cancelling its
 * first read would fail the screen that waits for it.
 */
const cancelReadsHoldingData = async (
  queryClient: QueryClient,
  client: HerculeClient,
  sessionIds: Iterable<string>,
): Promise<void> => {
  const queryKeys = [
    threadAndAgentSessionsQuery(client).queryKey,
    ...[...sessionIds].map((id) => sessionQuery(client, id).queryKey),
  ].filter((queryKey) => queryClient.getQueryData(queryKey) !== undefined);
  await Promise.all(queryKeys.map((queryKey) => queryClient.cancelQueries({ queryKey })));
};

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

/**
 * A Done move that has not finished: sent or waiting to be sent. The cached
 * Threads show it, and a read that lands meanwhile has it applied again.
 */
interface PendingDoneMove {
  readonly sessionIds: readonly string[];
  readonly move: DoneMove;
  /** The moment the move was made, so every application of it sorts the same. */
  readonly at: string;
}

/**
 * Applies each of `pending`, oldest first, to the cached Threads whenever a
 * read writes the thread list or the record of a Thread they move. Returns
 * the function that stops watching.
 *
 * A read can answer with the controller's state from before a move that is
 * still pending. A push from the controller starts such a read while the user
 * has Done and Reopen queued. Without this, the answer would put the rows
 * back where an earlier move left them until the last move finishes. Writes
 * made with `setQueryData`, which are the moves' own, are not read answers
 * and are left alone.
 */
const keepPendingMovesApplied = (
  queryClient: QueryClient,
  client: HerculeClient,
  pending: ReadonlySet<PendingDoneMove>,
): (() => void) =>
  queryClient.getQueryCache().subscribe((event) => {
    if (pending.size === 0) return;
    if (event.type !== "updated" || event.action.type !== "success") return;
    if (event.action.manual === true) return;
    const writesMovedThread = [...pending].some(
      ({ sessionIds }) =>
        matchQuery({ queryKey: threadAndAgentSessionsQuery(client).queryKey }, event.query) ||
        sessionIds.some((id) =>
          matchQuery({ queryKey: sessionQuery(client, id).queryKey }, event.query),
        ),
    );
    if (!writesMovedThread) return;
    for (const { sessionIds, move, at } of pending) {
      updateCachedSessions(queryClient, client, sessionIds, (session) =>
        applyDoneMove(session, move, at),
      );
    }
  });

/** The key every Done move runs under, so the moves can be counted. */
const DONE_MOVES_KEY = ["done-moves"];

/**
 * Checks that no Done move but the one finishing is still waiting or running.
 * A move is pending until its callbacks have run, so the one finishing
 * counts as one.
 */
const isLastDoneMove = (queryClient: QueryClient): boolean =>
  queryClient.isMutating({ mutationKey: DONE_MOVES_KEY }) === 1;

/** The three Done moves, as `useRunDoneMoves` describes them. */
interface DoneMoves {
  readonly markDone: (sessionIds: readonly string[]) => void;
  readonly reopen: (sessionIds: readonly string[]) => void;
  readonly undo: (undo: DoneUndo) => void;
}

/** What `useDoneMoves` returns: the three moves, and the store of the toast they show. */
export interface DoneMovesValue extends DoneMoves {
  readonly toasts: DoneToastStore;
}

/**
 * Runs the Done moves for `client`, and shows their toasts in `toasts`. A move takes a list of thread ids and is one request, applied by
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
 * cancels the reads running then, which may hold a state from before its
 * answer, and reads the list, and the Threads moved since the last read, again.
 *
 * The three functions keep their identity across renders, so the memoized
 * rows that take them do not draw again.
 */
const useRunDoneMoves = (client: HerculeClient, toasts: DoneToastStore): DoneMoves => {
  const queryClient = useQueryClient();
  // The Threads moved since the last time no move was pending. The last move
  // to finish reads their records again.
  const movedSinceRead = useRef(new Set<string>());
  // The moves not finished, oldest first (a Set keeps the order they were added in).
  const pending = useRef(new Set<PendingDoneMove>());
  useEffect(
    () => keepPendingMovesApplied(queryClient, client, pending.current),
    [queryClient, client],
  );

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
      // Pending from now, not after the cancelling below, so the moves are
      // applied in the order the user made them.
      const at = new Date().toISOString();
      const pendingMove = { sessionIds, move, at };
      pending.current.add(pendingMove);
      for (const id of sessionIds) movedSinceRead.current.add(id);
      await cancelReadsHoldingData(queryClient, client, sessionIds);
      updateCachedSessions(queryClient, client, sessionIds, (session) =>
        applyDoneMove(session, move, at),
      );
      if (!announce) return { pendingMove, toastSerial: null };
      const text = describeDoneMove(move, sessionIds.length, false);
      return {
        pendingMove,
        toastSerial: toasts.show(text, { move: reverseDoneMove(move), sessionIds }),
      };
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
    onSettled: async (_answered, _error, _request, context) => {
      if (context !== undefined) pending.current.delete(context.pendingMove);
      if (!isLastDoneMove(queryClient)) return;
      // The moves no longer cover the cached Threads, so a read that started
      // while one was pending, and answers now, would put back a state from
      // before the controller's last answer. Cancelling those reads and
      // reading again is simpler than keeping the moves applied until a read
      // that started after this point has answered.
      await cancelReadsHoldingData(queryClient, client, movedSinceRead.current);
      // A move made while the reads were stopping reads again when it
      // finishes, and keeps the Threads moved so far in `movedSinceRead`.
      if (pending.current.size > 0) return;
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

const DoneMovesContext = createContext<DoneMovesValue | null>(null);

/**
 * Runs the Done moves for `client` and offers them to `children`, which use
 * them with `useDoneMoves`. There is one queue and one toast for the whole
 * shell, so a move made in the thread header and one made in the sidebar are
 * sent in the order the user made them, and the last of them to finish reads
 * the threads again.
 *
 * The offered value never changes, so a move or a toast draws none of the
 * components that use it. Only the toast, which reads its store on its own,
 * draws again.
 */
export function DoneMovesProvider({
  client,
  children,
}: {
  readonly client: HerculeClient;
  readonly children: ReactNode;
}): JSX.Element {
  const [toasts] = useState(createDoneToastStore);
  const { markDone, reopen, undo } = useRunDoneMoves(client, toasts);
  const value = useMemo(
    () => ({ markDone, reopen, undo, toasts }),
    [markDone, reopen, undo, toasts],
  );
  return <DoneMovesContext value={value}>{children}</DoneMovesContext>;
}

/**
 * Returns the shell's Done moves and the store of the toast they show. The value keeps its identity, so the
 * component that calls this never draws again because of a move.
 */
export function useDoneMoves(): DoneMovesValue {
  const moves = use(DoneMovesContext);
  if (moves === null) throw new Error("No DoneMovesProvider above this component");
  return moves;
}
