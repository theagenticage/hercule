/**
 * Moving cards on the Work board, and the undo line at the foot of the screen.
 * It follows the Done moves (`app/done-moves.tsx`):
 *
 * - Moves are sent one at a time, in the order the user made them.
 * - The card moves on screen at once. The screen shows the board as the
 *   controller last gave it with every pending move applied over it
 *   (`reapplyCardMoves`), so a read that lands while a move is on its way
 *   cannot put the card back. A move leaves the pending list when it fails
 *   (the card goes back, and the line says why) or when a read that started
 *   after its answer has landed.
 * - Each move the user makes is one gesture on the undo stack, holding the
 *   place the card came from. An undo is a move too, but it adds no gesture.
 *   It joins the queue the moment Undo is pressed, so a move the user makes
 *   after Undo is sent after it.
 * - A move by key and an undo glide the cards on `hand`, and a card that goes
 *   back after a refused move glides home on `travel`. A move by drag is
 *   played by the drag, as the card lands.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { flushSync } from "react-dom";
import {
  matchQuery,
  notifyManager,
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { readErrorMessage, type HerculeClient } from "@hercule/client-core";
import {
  applyCardMove,
  buildWorkBoardKey,
  buildRestoreMove,
  readPlacement,
  reapplyCardMoves,
  type CardMove,
  type CardPlacement,
} from "@hercule/client-core/work";
import type { WorkBoard } from "@hercule/contract";
import { flipByKey, type SpringName } from "../../../app/motion";
import type { UndoStack } from "../../../app/undo-stack";
import { MOVABLE_SELECTOR, readMotionKey } from "../../../screens/work/board-layouts";
import { workBoardQuery } from "./-work-board";

/** How long the undo line stays after a move, and after a failure, which takes longer to read. */
const MOVE_LINE_MS = 5_200;
const FAILURE_LINE_MS = 8_000;

/** The key every card move runs under, so the moves can be counted. */
const CARD_MOVES_KEY = ["card-moves"];

/** A move that has not been reflected by a read yet: waiting, sent, or answered. */
interface PendingMove {
  readonly id: number;
  readonly move: CardMove;
  /** True once the controller accepted the move. It stays applied until a read shows it. */
  readonly isAnswered: boolean;
  /**
   * True once every read that ends from now on started after the answer, so
   * it shows the move (or whatever changed it since). The next successful read
   * retires the move.
   */
  readonly isCovered: boolean;
}

/** The pending moves, oldest first, as a store a component can follow. */
interface PendingMoves {
  readonly list: () => readonly PendingMove[];
  readonly add: (pending: PendingMove) => void;
  readonly markAnswered: (id: number) => void;
  readonly remove: (id: number) => void;
  /** Marks the answered moves covered: no read that is running now may start before their answers. */
  readonly coverAnswered: () => void;
  /** Removes the covered moves. Called when a read ends successfully. */
  readonly removeCovered: () => void;
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
    coverAnswered: () => {
      if (moves.some((each) => each.isAnswered && !each.isCovered)) {
        change(moves.map((each) => (each.isAnswered ? { ...each, isCovered: true } : each)));
      }
    },
    removeCovered: () => {
      if (moves.some((each) => each.isCovered)) change(moves.filter((each) => !each.isCovered));
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
   * The board jumps to the new place: the caller plays the movement, as the
   * drag does when its card lands.
   */
  readonly moveCard: (move: CardMove, words: string) => void;
  /** Does what `moveCard` does, and glides the cards to their new places on `hand`. For a move by key. */
  readonly moveCardWithMotion: (move: CardMove, words: string) => void;
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

const NOT_SAVED_MESSAGE = "That move did not save, so there is nothing to put back.";

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
 * Makes `putBack` the way gestures put a card back, and returns the function
 * that takes it out again when the screen leaves.
 */
const registerOpenScreen = (undoStack: UndoStack, putBack: OpenScreen["putBack"]): (() => void) => {
  const openScreen = findOrCreateOpenScreen(undoStack);
  openScreen.putBack = putBack;
  return () => {
    if (openScreen.putBack === putBack) openScreen.putBack = null;
  };
};

/**
 * Cancels the board's running reads, marks the answered moves covered, and
 * reads the board again. A read that is running now may have started before
 * the last move was answered, so it could show the board without that move.
 * Every read that ends after the cancel started after the answers, so the
 * next successful read, this one or any later one, retires the covered moves
 * (see `useCardMoves`).
 *
 * The read runs even while the window is hidden: a move the user just made
 * must not show undone when the window comes back. It does not wait for the
 * queue, so the next move is never held up by a slow read. When this read
 * fails, the answered moves stay applied until a later read succeeds.
 */
const readBoardAfterMoves = async (
  queryClient: QueryClient,
  client: HerculeClient,
  pending: PendingMoves,
): Promise<void> => {
  await queryClient.cancelQueries({ queryKey: buildWorkBoardKey() });
  // A move made while the reads were stopping reads again when it finishes.
  if (pending.hasUnanswered()) return;
  pending.coverAnswered();
  try {
    await queryClient.fetchQuery({ ...workBoardQuery(client), staleTime: 0 });
  } catch {
    // The covered moves stay applied; a later read retires them.
  }
};

/**
 * Hands the undo stack's gestures the Work screen that is open now. A gesture
 * outlives the screen that made it: leaving Work and coming back mounts
 * `useCardMoves` again with a new pending list, and an Undo pressed there must
 * move the card through that list, not through the closed screen's. The
 * screen puts itself here when it mounts and takes itself out when it leaves.
 */
interface OpenScreen {
  /** The screen's way to put a card back, or `null` while no Work screen is open. */
  putBack: ((place: CardPlacement) => PutBackRequest | undefined) | null;
  /** Whether the last card put back went last in its cell because the card it followed had gone. */
  wasInexact: boolean;
}

/** A card being put back: whether it went exactly where it was, and the request that moves it. */
interface PutBackRequest {
  readonly isExact: boolean;
  readonly request: Promise<unknown>;
}

const openScreens = new WeakMap<UndoStack, OpenScreen>();

/** Returns the record of the open Work screen for `undoStack`, creating it on first use. */
const findOrCreateOpenScreen = (undoStack: UndoStack): OpenScreen => {
  const found = openScreens.get(undoStack);
  if (found !== undefined) return found;
  const created: OpenScreen = { putBack: null, wasInexact: false };
  openScreens.set(undoStack, created);
  return created;
};

/**
 * Moves cards for `client` and returns the board to draw. `serverBoard` is the
 * board as the last read gave it, and `scrollRef` is the element that scrolls
 * the board, which the motion of a move measures.
 *
 * - `moveCard` shows the move at once, sends `task.move` after the moves
 *   before it, and pushes a gesture on `undoStack`. A move that fails leaves
 *   the pending list, so the card goes back, and the line says why. The
 *   gesture of a failed move is taken off the stack when it is the newest.
 * - A gesture's undo joins the queue at once, behind the gesture's own
 *   request, and moves the card back to the place it came from. The place is
 *   worked out from the gesture and the board on screen when Undo is pressed.
 *   When the card it followed has gone, the card goes last in that cell, and
 *   the line says so. When the gesture's request is refused, the card is
 *   already in that place, which the controller accepts without writing, and
 *   the line says there was nothing to put back.
 * - The last move to finish cancels the running reads and reads the board
 *   again. Every successful read after that retires the moves answered
 *   before it, whoever started it.
 */
export const useCardMoves = ({
  client,
  undoStack,
  serverBoard,
  scrollRef,
}: {
  readonly client: HerculeClient;
  readonly undoStack: UndoStack;
  readonly serverBoard: WorkBoard | undefined;
  readonly scrollRef: RefObject<HTMLElement | null>;
}): CardMoves => {
  const queryClient = useQueryClient();
  const [pending] = useState(createPendingMoves);
  const pendingMoves = useSyncExternalStore(pending.subscribe, pending.list);
  const nextId = useRef(1);
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

  /**
   * Makes `change` and glides every part of the board that moves because of
   * it on `spring`. The change is committed at once, because the board is
   * measured again right after it. With no board on screen, only makes it.
   */
  const playBoardChange = (spring: SpringName, change: () => void): void => {
    const scroller = scrollRef.current;
    if (scroller === null) {
      change();
      return;
    }
    flipByKey({
      root: scroller,
      selector: MOVABLE_SELECTOR,
      readKey: readMotionKey,
      spring,
      mutate: () => {
        flushSync(change);
      },
    });
  };

  const readShownBoard = (): WorkBoard | undefined => {
    const server = queryClient.getQueryData<WorkBoard>(buildWorkBoardKey());
    return server === undefined
      ? undefined
      : reapplyCardMoves(
          server,
          pending.list().map((each) => each.move),
        );
  };

  // A read that ends after the queue emptied started after the answers of the
  // covered moves, so it shows them (or what changed them since).
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (
          event.type !== "updated" ||
          event.action.type !== "success" ||
          event.action.manual === true ||
          !matchQuery({ queryKey: buildWorkBoardKey() }, event.query)
        ) {
          return;
        }
        // Queued behind the observers of the read, so the screen gets the new
        // board and the shorter list in one render.
        notifyManager.schedule(pending.removeCovered);
      }),
    [queryClient, pending],
  );

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
      playBoardChange("travel", () => {
        pending.remove(id);
      });
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

  /**
   * Shows `move` and queues it. Resolves when it was accepted, rejects when it
   * was not. The cards glide on `hand` when `isPlayed` is true.
   */
  const sendMove = (move: CardMove, isPlayed: boolean): Promise<unknown> => {
    const request: PendingMove = {
      id: nextId.current++,
      move,
      isAnswered: false,
      isCovered: false,
    };
    if (isPlayed) {
      playBoardChange("hand", () => {
        pending.add(request);
      });
    } else {
      pending.add(request);
    }
    return mutateAsync(request);
  };

  /**
   * Shows the card back at `place`, as Undo does, and queues the move. Returns
   * `undefined` when the card is no longer on the board.
   */
  const putCardBack = (place: CardPlacement): PutBackRequest | undefined => {
    const board = readShownBoard();
    const restore = board === undefined ? undefined : buildRestoreMove(board, place);
    if (restore === undefined) return undefined;
    return { isExact: restore.exact, request: sendMove(restore.move, true) };
  };

  useEffect(() => registerOpenScreen(undoStack, putCardBack));

  const makeMove = (move: CardMove, words: string, isPlayed: boolean): void => {
    const board = readShownBoard();
    if (board === undefined) return;
    const from = readPlacement(board, move.taskId);
    if (from === undefined) return;
    if (isSamePlace(from, readPlacement(applyCardMove(board, move), move.taskId))) return;

    const wasSaved = sendMove(move, isPlayed).then(
      () => true,
      () => false,
    );
    let isRefused = false;
    const gesture = {
      words,
      undo: async (): Promise<void> => {
        if (isRefused) throw new Error(NOT_SAVED_MESSAGE);
        // The screen that is open now owns the pending list the card moves in,
        // which may not be the screen that made the gesture.
        const openScreen = findOrCreateOpenScreen(undoStack);
        if (openScreen.putBack === null) throw new Error("Open Work to put the card back.");
        const putBack = openScreen.putBack(from);
        if (putBack === undefined) throw new Error("The card is no longer on the board.");
        openScreen.wasInexact = !putBack.isExact;
        await putBack.request;
        if (!(await wasSaved)) throw new Error(NOT_SAVED_MESSAGE);
      },
    };
    undoStack.push(gesture);
    sayLine(`${words}.`, true);
    // A move that failed has nothing to undo. Taking its gesture off the stack
    // keeps the next Undo for the move before it. The gesture is removed by
    // running it: it throws for a refused move, and nothing is sent.
    void wasSaved.then((saved) => {
      if (saved) return;
      isRefused = true;
      if (undoStack.peek() === gesture) void undoStack.undo();
    });
  };

  const moveCard = (move: CardMove, words: string): void => {
    makeMove(move, words, false);
  };

  const moveCardWithMotion = (move: CardMove, words: string): void => {
    makeMove(move, words, true);
  };

  const undoLastMove = (): void => {
    findOrCreateOpenScreen(undoStack).wasInexact = false;
    void undoStack.undo().then((outcome) => {
      switch (outcome.kind) {
        case "empty":
          sayLine("Nothing to undo.", false);
          return;
        case "busy":
          return;
        case "reversed":
          sayLine(
            findOrCreateOpenScreen(undoStack).wasInexact
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
    moveCardWithMotion,
    undoLastMove,
    line,
    sayFailure: (text) => {
      sayLine(text, false);
    },
  };
};
