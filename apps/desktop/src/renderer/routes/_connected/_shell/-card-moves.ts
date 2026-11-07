/**
 * Moving cards on the Work board, and the undo line at the foot of the screen.
 * It follows the Done moves (`app/done-moves.tsx`):
 *
 * - Moves are sent one at a time, in the order the user made them.
 * - The card moves on screen at once. The screen shows the board as the
 *   controller last gave it with every pending move applied over it
 *   (`reapplyCardMoves`), so a read that lands while a move is on its way
 *   cannot put the card back. A move leaves the pending list when it fails
 *   (the card goes back, and the line says why) or after the last move has
 *   finished and the board has been read again.
 * - Each move the user makes is one gesture on the undo stack, holding the
 *   place the card came from. An undo is a move too, but it adds no gesture.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { readErrorMessage, type HerculeClient } from "@hercule/client-core";
import {
  applyCardMove,
  buildRestoreMove,
  readPlacement,
  reapplyCardMoves,
  type CardMove,
  type CardPlacement,
} from "@hercule/client-core/work";
import type { WorkBoard } from "@hercule/contract";
import type { UndoStack } from "../../../app/undo-stack";
import { WORK_BOARD_KEY, workBoardQuery } from "./-work-board";

/** How long the undo line stays after a move, and after a failure, which takes longer to read. */
const MOVE_LINE_MS = 5_200;
const FAILURE_LINE_MS = 8_000;

/** The key every card move runs under, so the moves can be counted. */
const CARD_MOVES_KEY = ["card-moves"];

/** A move that has not been reflected by a read yet: waiting, sent, or answered. */
interface PendingMove {
  readonly id: number;
  readonly move: CardMove;
  /** True once the controller accepted the move. It stays applied until the board is read again. */
  readonly isAnswered: boolean;
}

/** The pending moves, oldest first, as a store a component can follow. */
interface PendingMoves {
  readonly list: () => readonly PendingMove[];
  readonly add: (pending: PendingMove) => void;
  readonly markAnswered: (id: number) => void;
  readonly remove: (id: number) => void;
  /** Removes the answered moves: a read that started after their answers now shows them. */
  readonly removeAnswered: () => void;
  readonly hasUnanswered: () => boolean;
  readonly subscribe: (listener: () => void) => () => void;
}

const createPendingMoves = (): PendingMoves => {
  let moves: readonly PendingMove[] = [];
  const listeners = new Set<() => void>();
  const change = (next: readonly PendingMove[]): void => {
    moves = next;
    for (const listener of listeners) listener();
  };
  return {
    list: () => moves,
    add: (pending) => {
      change([...moves, pending]);
    },
    markAnswered: (id) => {
      change(moves.map((each) => (each.id === id ? { ...each, isAnswered: true } : each)));
    },
    remove: (id) => {
      change(moves.filter((each) => each.id !== id));
    },
    removeAnswered: () => {
      if (moves.some((each) => each.isAnswered)) change(moves.filter((each) => !each.isAnswered));
    },
    hasUnanswered: () => moves.some((each) => !each.isAnswered),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/** What the undo line shows: its text, whether it offers Undo, and whether it is in view. */
export interface MoveLine {
  readonly text: string;
  readonly canUndo: boolean;
  readonly isShown: boolean;
  /** Rises on every new line, so the timer that hides the line starts again. */
  readonly serial: number;
}

const QUIET_LINE: MoveLine = { text: "", canUndo: false, isShown: false, serial: 0 };

/** What `useCardMoves` returns. */
export interface CardMoves {
  /** The board with the pending moves applied, or `undefined` until the first read ends. */
  readonly board: WorkBoard | undefined;
  /**
   * Moves a card. The card moves on screen at once, and a failure puts it
   * back and says why. `words` say what happened, in the past tense, such as
   * "Moved Review PR to In review". A move that changes nothing does nothing.
   */
  readonly moveCard: (move: CardMove, words: string) => void;
  /** Reverses the newest gesture on the undo stack, and says what happened. */
  readonly undoLastMove: () => void;
  /** What the undo line shows. */
  readonly line: MoveLine;
  /**
   * Shows `text` on the undo line with no Undo, for a failure of something
   * else on the board, such as a Task that could not be added.
   */
  readonly sayFailure: (text: string) => void;
}

/** Returns the sentence the undo line shows for a move that failed. */
const describeMoveFailure = (error: unknown): string =>
  `The move did not save, so the card went back: ${readErrorMessage(error).replace(/\.+$/, "")}. Try the move again.`;

/** Returns whether the two places are the same: same cell, same card before it. */
const isSamePlace = (a: CardPlacement, b: CardPlacement | undefined): boolean =>
  b !== undefined &&
  a.stage === b.stage &&
  a.projectId === b.projectId &&
  a.afterTaskId === b.afterTaskId;

/**
 * Cancels the board's running reads and reads it again, then drops the
 * answered moves. A read that is running now may have started before the last
 * move was answered, so it could show the board without that move.
 *
 * The read runs even while the window is hidden: a move the user just made
 * must not show undone when the window comes back. It does not wait for the
 * queue, so the next move is never held up by a slow read. When the read fails,
 * the answered moves stay applied until the next one succeeds.
 */
const readBoardAfterMoves = async (
  queryClient: QueryClient,
  client: HerculeClient,
  pending: PendingMoves,
): Promise<void> => {
  await queryClient.cancelQueries({ queryKey: WORK_BOARD_KEY });
  // A move made while the reads were stopping reads again when it finishes.
  if (pending.hasUnanswered()) return;
  try {
    await queryClient.fetchQuery({ ...workBoardQuery(client), staleTime: 0 });
  } catch {
    return;
  }
  pending.removeAnswered();
};

/**
 * Moves cards for `client` and returns the board to draw. `serverBoard` is the
 * board as the last read gave it.
 *
 * - `moveCard` shows the move at once, sends `task.move` after the moves
 *   before it, and pushes a gesture on `undoStack`. A move that fails leaves
 *   the pending list, so the card goes back, and the line says why. The
 *   gesture of a failed move is taken off the stack when it is the newest.
 * - A gesture's undo waits for its own request, then moves the card back to
 *   the place it came from. When the card it followed has gone, the card goes
 *   last in that cell, and the line says so.
 * - The last move to finish reads the board again.
 */
export const useCardMoves = ({
  client,
  undoStack,
  serverBoard,
}: {
  readonly client: HerculeClient;
  readonly undoStack: UndoStack;
  readonly serverBoard: WorkBoard | undefined;
}): CardMoves => {
  const queryClient = useQueryClient();
  const [pending] = useState(createPendingMoves);
  const pendingMoves = useSyncExternalStore(pending.subscribe, pending.list);
  const nextId = useRef(1);
  const wasInexact = useRef(false);
  const [line, setLine] = useState<MoveLine>(QUIET_LINE);

  const sayLine = (text: string, canUndo: boolean): void => {
    setLine((before) => ({ text, canUndo, isShown: true, serial: before.serial + 1 }));
  };

  useEffect(() => {
    if (!line.isShown) return;
    const timer = setTimeout(
      () => {
        setLine((now) => (now.serial === line.serial ? { ...now, isShown: false } : now));
      },
      line.canUndo ? MOVE_LINE_MS : FAILURE_LINE_MS,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [line.serial, line.isShown, line.canUndo]);

  const readShownBoard = (): WorkBoard | undefined => {
    const server = queryClient.getQueryData<WorkBoard>(WORK_BOARD_KEY);
    return server === undefined
      ? undefined
      : reapplyCardMoves(
          server,
          pending.list().map((each) => each.move),
        );
  };

  const { mutateAsync } = useMutation({
    mutationKey: CARD_MOVES_KEY,
    // A move in a scope waits for the one before it to finish before it is sent.
    scope: { id: "card-moves" },
    mutationFn: ({ move }: PendingMove) => {
      const { taskId, ...place } = move;
      return client.task.move({ params: { id: taskId }, payload: place });
    },
    onSuccess: (_task, { id }) => {
      pending.markAnswered(id);
    },
    onError: (error, { id }) => {
      pending.remove(id);
      sayLine(describeMoveFailure(error), false);
    },
    // Runs after the answer or the error. The move being settled still counts
    // as a running mutation, so it is the last one when the count is one.
    onSettled: () => {
      if (queryClient.isMutating({ mutationKey: CARD_MOVES_KEY }) === 1) {
        void readBoardAfterMoves(queryClient, client, pending);
      }
    },
  });

  /** Shows `move` and queues it. Resolves when it was accepted, rejects when it was not. */
  const sendMove = (move: CardMove): Promise<unknown> => {
    const request: PendingMove = { id: nextId.current++, move, isAnswered: false };
    pending.add(request);
    return mutateAsync(request);
  };

  const moveCard = (move: CardMove, words: string): void => {
    const board = readShownBoard();
    if (board === undefined) return;
    const from = readPlacement(board, move.taskId);
    if (from === undefined) return;
    if (isSamePlace(from, readPlacement(applyCardMove(board, move), move.taskId))) return;

    const wasSaved = sendMove(move).then(
      () => true,
      () => false,
    );
    const gesture = {
      words,
      undo: async (): Promise<void> => {
        if (!(await wasSaved)) {
          throw new Error("That move did not save, so there is nothing to put back.");
        }
        const current = readShownBoard();
        const restore = current === undefined ? undefined : buildRestoreMove(current, from);
        if (restore === undefined) throw new Error("The card is no longer on the board.");
        wasInexact.current = !restore.exact;
        await sendMove(restore.move);
      },
    };
    undoStack.push(gesture);
    sayLine(`${words}.`, true);
    // A move that failed has nothing to undo. Taking its gesture off the stack
    // keeps the next Undo for the move before it. The gesture is removed by
    // running it: it throws for a move that did not save, and nothing is sent.
    void wasSaved.then((saved) => {
      if (!saved && undoStack.peek() === gesture) void undoStack.undo();
    });
  };

  const undoLastMove = (): void => {
    wasInexact.current = false;
    void undoStack.undo().then((outcome) => {
      switch (outcome.kind) {
        case "empty":
          sayLine("Nothing to undo.", false);
          return;
        case "busy":
          return;
        case "reversed":
          sayLine(
            wasInexact.current
              ? `Put back: ${outcome.words}. The card it followed has gone, so it went last in its column.`
              : `Put back: ${outcome.words}.`,
            false,
          );
          return;
        case "failed":
          sayLine(`Could not put back: ${outcome.words}. ${outcome.reason}`, false);
      }
    });
  };

  return {
    board:
      serverBoard === undefined
        ? undefined
        : reapplyCardMoves(
            serverBoard,
            pendingMoves.map((each) => each.move),
          ),
    moveCard,
    undoLastMove,
    line,
    sayFailure: (text) => {
      sayLine(text, false);
    },
  };
};
