/**
 * Moving cards on the Work board, and the undo line at the foot of the screen.
 * It follows the Done moves (`app/done-moves.tsx`):
 *
 * - Moves are sent one at a time, in the order the user made them.
 * - The card moves on screen at once. The screen shows the board in the
 *   query cache with every pending move applied over it (`reapplyCardMoves`),
 *   so a read that lands while a move is on its way cannot put the card back.
 *   A move is pending from the moment it is made until the controller answers.
 * - When the controller accepts a move, the move is written into the cached
 *   board and leaves the pending list. A move it refuses leaves the pending
 *   list alone, so the card goes back, and the line says why.
 * - Each move the user makes is one gesture on the undo stack, holding the
 *   place the card came from. An undo is a move too, but it adds no gesture.
 *   It joins the queue the moment Undo is pressed, so a move the user makes
 *   after Undo is sent after it.
 * - A move by key and an undo glide the cards on `hand`, and a card that goes
 *   back after a refused move glides home on `travel`. A move by drag is
 *   played by the drag, as the card lands.
 * - Done and Drop (`endCard`) go through the same queue, the same pending
 *   list and the same undo stack. The card leaves the board at once, in a
 *   copy that flies to the count of its stage (Done) or sinks (Dropped). Its
 *   gesture holds the card as it was and the place it stood, so Undo can put
 *   it back exactly, and a refused update brings it back.
 */
import { useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys, readErrorMessage, type HerculeClient } from "@hercule/client-core";
import {
  applyCardChange,
  applyCardMove,
  buildMoveToPlacement,
  buildRestoreMove,
  CARD_ENDED_NOTE,
  CARD_NOT_EXACT_NOTE,
  describeCardEnd,
  describeCardEndFailure,
  readPlacement,
  reapplyCardChanges,
  type CardChange,
  type CardMove,
  type CardPlacement,
  type EndStage,
} from "@hercule/client-core/work";
import type { WorkBoard, WorkCard } from "@hercule/contract";
import type { SpringName } from "../../../app/motion";
import type { CardMover, PutBackRequest } from "../../../app/card-mover";
import type { Gesture, UndoStack } from "../../../app/undo-stack";
import { useUndoLine, type UndoLineState } from "../../../app/use-undo-line";
import { launchLeavingCard, sendLeavingCard } from "../../../screens/work/board-flights";
import { flipBoard } from "../../../screens/work/flip-board";
import { workBoardQuery } from "./-work-board";

/** The key every card move runs under, so the moves can be counted. */
const CARD_MOVES_KEY = ["card-moves"];

/** A move the controller has not answered yet: waiting to be sent, or sent. */
interface PendingMove {
  readonly id: number;
  readonly change: CardChange;
  /**
   * Set on the move that undoes another. The move is sent only when this
   * resolves to true, which it does when the move being undone was saved.
   * Otherwise the card is still where the undo would put it, or another client
   * has moved it since, and writing the undo would overwrite that.
   */
  readonly isUndoWanted: Promise<boolean> | undefined;
}

const NO_MOVES: readonly PendingMove[] = [];

/** What `useCardMoves` returns. */
export interface CardMoves {
  /** The board with the pending moves applied, or `undefined` until the first read ends. */
  readonly board: WorkBoard | undefined;
  /**
   * Moves a card. The card moves on screen at once, and a failure puts it
   * back and says why. `words` say what happened, in the past tense, such as
   * "Moved Review PR to In review". `note`, when given, follows the words on
   * the line, such as why the card landed somewhere else than the user aimed.
   * A move that changes nothing does nothing. The board jumps to the new place: the caller plays the movement, as the
   * drag does when its card lands.
   */
  readonly moveCard: (move: CardMove, words: string, note?: string) => void;
  /** Does what `moveCard` does, and glides the cards to their new places on `hand`. For a move by key. */
  readonly moveCardWithMotion: (move: CardMove, words: string, note?: string) => void;
  /**
   * Marks the Task `taskId` Done or Dropped (`stage`). The card leaves the
   * board at once, with the motion of its stage's count (Done) or a sink
   * (Dropped), and the update is sent after the moves before it. The undo line
   * offers Undo, which puts the card back in the exact place it stood. A
   * refused update brings the card back and says why. A card that is not on
   * the board is left alone.
   */
  readonly endCard: (taskId: string, stage: EndStage) => void;
  /** Reverses the newest gesture on the undo stack, and says what happened. */
  readonly undoLastMove: () => void;
  /** What the undo line shows. */
  readonly line: UndoLineState;
  /**
   * Shows `text` on the undo line with no Undo, for a failure of something
   * else on the board, such as a Task that could not be added.
   */
  readonly sayWithoutUndo: (text: string) => void;
  /**
   * Puts `gesture` on the undo stack and shows `text` on the undo line with
   * Undo, for a gesture that is not a card move, such as answering a question
   * or trying a failed run again. Returns a function that takes the gesture
   * off the stack again, for a gesture that cannot be undone any more.
   */
  readonly sayWithUndo: (text: string, gesture: Gesture<CardMover>) => () => void;
}

const NOT_SAVED_MESSAGE = "That move did not save, so there is nothing to put back.";
const END_NOT_SAVED_MESSAGE = "That update did not save, so there is nothing to put back.";

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
 * Returns the id of the card that sits next to `card` in its cell, after it
 * when there is one, else before it, or `null` for a card alone in its cell.
 * It is read from the page, so it names a card the user can see.
 */
const findNeighbourCardId = (card: HTMLElement): string | null => {
  const neighbour = [card.nextElementSibling, card.previousElementSibling].find(
    (each) => each instanceof HTMLElement && each.dataset["cardId"] !== undefined,
  );
  return neighbour instanceof HTMLElement ? (neighbour.dataset["cardId"] ?? null) : null;
};

/**
 * Moves cards for `client` and returns the board to draw. `serverBoard` is the
 * board as the last read gave it, and `scrollRef` is the element that scrolls
 * the board, which the motion of a move measures.
 *
 * - `moveCard` shows the move at once, sends `task.move` after the moves
 *   before it, and pushes a gesture on `undoStack`. A move that fails leaves
 *   the pending list, so the card goes back, and the line says why. The
 *   gesture of a failed move is taken off the stack.
 * - When the controller accepts a move, the board in the query cache is
 *   patched with that one move, as the controller has it, and the move leaves
 *   the pending list. Later pending moves are never written into the cache:
 *   they stay on top of it until they are answered themselves. Before it
 *   patches, the answer cancels the board's running reads, because one that
 *   started before the answer could publish a board without the move after
 *   the patch.
 * - A gesture's undo joins the queue at once, behind the gesture's own
 *   request, and moves the card back to the place it came from. The place is
 *   worked out from the gesture and the board on screen when Undo is pressed.
 *   The gesture moves the card through the screen that is open when Undo is
 *   pressed (`CardMover`), which may be a later screen than the one that made
 *   the gesture. When the card it followed has gone, the card goes last in
 *   that stage, and the line says so. The undo is sent only after the gesture's own
 *   request was accepted, checked when the undo reaches the front of the queue.
 *   When the request is refused, the undo is not sent, because the card is
 *   still where it was or another client has moved it since. The line says
 *   there was nothing to put back.
 * - The last move to finish reads the board again. The queue does not wait
 *   for that read, so the next move is never held up by a slow read.
 */
export const useCardMoves = ({
  client,
  undoStack,
  serverBoard,
  scrollRef,
  onCardReturning,
}: {
  readonly client: HerculeClient;
  readonly undoStack: UndoStack<CardMover>;
  readonly serverBoard: WorkBoard | undefined;
  readonly scrollRef: RefObject<HTMLElement | null>;
  /**
   * Called just before a card that was marked Done or Dropped is drawn on the
   * board again, by Undo or because the update was refused. The screen then
   * lets the card in at once and plays its return (`returnCard`), instead of
   * holding it back as a Task that arrived by itself.
   */
  readonly onCardReturning: (taskId: string, stage: EndStage) => void;
}): CardMoves => {
  const queryClient = useQueryClient();
  // The pending moves are kept twice. The ref is what a gesture reads, so two
  // gestures before one render see each other's move. The state draws the board.
  const pendingRef = useRef<readonly PendingMove[]>(NO_MOVES);
  const [pendingMoves, setPendingMoves] = useState(NO_MOVES);
  const changePending = (change: (moves: readonly PendingMove[]) => readonly PendingMove[]) => {
    pendingRef.current = change(pendingRef.current);
    setPendingMoves(pendingRef.current);
  };
  const nextId = useRef(1);
  const { line, say, undo } = useUndoLine(undoStack);

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
    flipBoard(scroller, spring, () => {
      flushSync(change);
    });
  };

  const readShownBoard = (): WorkBoard | undefined => {
    const cached = queryClient.getQueryData<WorkBoard>(queryKeys.workBoard());
    return cached === undefined
      ? undefined
      : reapplyCardChanges(
          cached,
          pendingRef.current.map((each) => each.change),
        );
  };

  const { mutateAsync } = useMutation({
    mutationKey: CARD_MOVES_KEY,
    // A move in a scope waits for the one before it to finish before it is sent.
    scope: { id: "card-moves" },
    // Resolves to false when the move was not sent because it undoes a move that did not save.
    mutationFn: async ({ change, isUndoWanted }: PendingMove): Promise<boolean> => {
      if (isUndoWanted !== undefined && !(await isUndoWanted)) return false;
      if (change.kind === "end") {
        await client.task.update({
          params: { id: change.card.id },
          payload: { stage: change.stage },
        });
        return true;
      }
      const { taskId, ...place } = change.move;
      await client.task.move({ params: { id: taskId }, payload: place });
      return true;
    },
    onSuccess: async (isSent, { id, change }) => {
      if (isSent) {
        // A read that started before this answer could end after the patch and
        // put the card back. Cancelling reverts it, and the push that follows
        // starts a read that began after the answer.
        await queryClient.cancelQueries({ queryKey: queryKeys.workBoard() });
        queryClient.setQueryData<WorkBoard>(queryKeys.workBoard(), (cached) =>
          cached === undefined ? undefined : applyCardChange(cached, change),
        );
      }
      // Right after the patch, with no wait between, so React draws the
      // patched board and the shorter list together.
      changePending((moves) => moves.filter((each) => each.id !== id));
    },
    onError: (error, { id, change }) => {
      if (change.kind === "end") onCardReturning(change.card.id, change.stage);
      playBoardChange("travel", () => {
        changePending((moves) => moves.filter((each) => each.id !== id));
      });
      say(
        change.kind === "end"
          ? describeCardEndFailure(change.card, change.stage, readErrorMessage(error))
          : describeMoveFailure(error),
        false,
      );
    },
    // Runs after the answer or the error. The move being settled still counts
    // as a running mutation, so it is the last one when the count is one.
    onSettled: () => {
      if (queryClient.isMutating({ mutationKey: CARD_MOVES_KEY }) !== 1) return;
      // The read runs even while the window is hidden: a move the user just
      // made must not show undone when the window comes back. It is not
      // awaited, so a slow read never holds up the next move. When it fails,
      // the cache keeps the moves the controller answered.
      queryClient.fetchQuery({ ...workBoardQuery(client), staleTime: 0 }).catch(() => undefined);
    },
  });

  /**
   * Shows `change` and queues it. Resolves when it was accepted, rejects when
   * it was not. The cards glide on `hand` when `isPlayed` is true. Pass
   * `isUndoWanted` for a change that undoes another (see `PendingMove`).
   * `onShown` runs right after the board shows the change, before the
   * request is queued.
   */
  const sendChange = (
    change: CardChange,
    isPlayed: boolean,
    isUndoWanted: Promise<boolean> | undefined = undefined,
    onShown: (() => void) | undefined = undefined,
  ): Promise<unknown> => {
    const request: PendingMove = {
      id: nextId.current++,
      change,
      isUndoWanted,
    };
    if (isPlayed) {
      playBoardChange("hand", () => {
        changePending((moves) => [...moves, request]);
      });
    } else {
      changePending((moves) => [...moves, request]);
    }
    onShown?.();
    return mutateAsync(request);
  };

  const sendMove = (
    move: CardMove,
    isPlayed: boolean,
    isUndoWanted: Promise<boolean> | undefined = undefined,
  ): Promise<unknown> => sendChange({ kind: "move", move }, isPlayed, isUndoWanted);

  /**
   * Shows the card back at `place`, as Undo does, and queues the move, which is
   * sent only if `isUndoWanted` resolves to true. Returns `undefined` when the
   * card is no longer on the board.
   */
  const putCardBack = (
    place: CardPlacement,
    isUndoWanted: Promise<boolean>,
  ): PutBackRequest | undefined => {
    const board = readShownBoard();
    const restore = board === undefined ? undefined : buildRestoreMove(board, place);
    if (restore === undefined) return undefined;
    return { isExact: restore.exact, request: sendMove(restore.move, true, isUndoWanted) };
  };

  /**
   * Shows `card`, which ended at `stage`, back at `place`, as Undo does, and
   * queues the move that takes the Task out of its end. The move is sent only
   * if `isUndoWanted` resolves to true. Returns `undefined` when the card is
   * on the board already.
   */
  const putEndedCardBack = (
    card: WorkCard,
    place: CardPlacement,
    stage: EndStage,
    isUndoWanted: Promise<boolean>,
  ): PutBackRequest | undefined => {
    const board = readShownBoard();
    if (board === undefined || board.cards.some((each) => each.id === card.id)) return undefined;
    const restore = buildMoveToPlacement(board, place);
    onCardReturning(card.id, stage);
    return {
      isExact: restore.exact,
      request: sendChange({ kind: "return", card, move: restore.move }, true, isUndoWanted),
    };
  };

  /**
   * Puts the gesture that Undo reverses on the stack and shows its words on
   * the undo line. `putBack` asks the open screen to bring the card back. A
   * gesture whose request failed is taken off the stack again, because it has
   * nothing to reverse and the next Undo is for the gesture before it.
   */
  const offerUndo = (
    words: string,
    note: string | undefined,
    wasSaved: Promise<boolean>,
    putBack: (mover: CardMover) => PutBackRequest | undefined,
    messages: { readonly missing: string; readonly notSaved: string },
  ): void => {
    const gesture: Gesture<CardMover> = {
      words,
      undo: async (mover) => {
        const request = putBack(mover);
        if (request === undefined) throw new Error(messages.missing);
        await request.request;
        if (!(await wasSaved)) throw new Error(messages.notSaved);
        return request.isExact ? undefined : CARD_NOT_EXACT_NOTE;
      },
    };
    undoStack.push(gesture);
    say(note === undefined ? `${words}.` : `${words}. ${note}`, true);
    void wasSaved.then((saved) => {
      if (!saved) undoStack.remove(gesture);
    });
  };

  const endCard = (taskId: string, stage: EndStage): void => {
    const board = readShownBoard();
    const card = board?.cards.find((each) => each.id === taskId);
    const from = board === undefined ? undefined : readPlacement(board, taskId);
    if (card === undefined || from === undefined) return;

    // The card in the page flies away as a copy, and its neighbour takes the
    // focus the card had, so the keys go on from where they were.
    const scroller = scrollRef.current;
    const element = scroller?.querySelector<HTMLElement>(`[data-card-id="${taskId}"]`) ?? null;
    const neighbourId = element === null ? null : findNeighbourCardId(element);
    const hadFocus = element !== null && document.activeElement === element;
    const ghost = scroller === null ? null : launchLeavingCard(scroller, taskId);

    const wasSaved = sendChange({ kind: "end", card, stage }, true, undefined, () => {
      if (scroller !== null && ghost !== null) sendLeavingCard(scroller, ghost, stage, card.stage);
      if (hadFocus && neighbourId !== null) {
        scroller?.querySelector<HTMLElement>(`[data-card-id="${neighbourId}"]`)?.focus({
          preventScroll: true,
        });
      }
    }).then(
      () => true,
      () => false,
    );
    offerUndo(
      describeCardEnd(card, stage),
      CARD_ENDED_NOTE,
      wasSaved,
      (mover) => mover.putEndedCardBack(card, from, stage, wasSaved),
      { missing: "The Task is already back on the board.", notSaved: END_NOT_SAVED_MESSAGE },
    );
  };

  const makeMove = (
    move: CardMove,
    words: string,
    note: string | undefined,
    isPlayed: boolean,
  ): void => {
    const board = readShownBoard();
    if (board === undefined) return;
    const from = readPlacement(board, move.taskId);
    if (from === undefined) return;
    if (isSamePlace(from, readPlacement(applyCardMove(board, move), move.taskId))) return;

    const wasSaved = sendMove(move, isPlayed).then(
      () => true,
      () => false,
    );
    offerUndo(words, note, wasSaved, (mover) => mover.putCardBack(from, wasSaved), {
      missing: "The card is no longer on the board.",
      notSaved: NOT_SAVED_MESSAGE,
    });
  };

  const moveCard = (move: CardMove, words: string, note?: string): void => {
    makeMove(move, words, note, false);
  };

  const moveCardWithMotion = (move: CardMove, words: string, note?: string): void => {
    makeMove(move, words, note, true);
  };

  const undoLastMove = (): void => {
    undo({ putCardBack, putEndedCardBack });
  };

  return {
    board:
      serverBoard === undefined
        ? undefined
        : reapplyCardChanges(
            serverBoard,
            pendingMoves.map((each) => each.change),
          ),
    moveCard,
    moveCardWithMotion,
    endCard,
    undoLastMove,
    line,
    sayWithoutUndo: (text) => {
      say(text, false);
    },
    sayWithUndo: (text, gesture) => {
      undoStack.push(gesture);
      say(text, true);
      return () => {
        undoStack.remove(gesture);
      };
    },
  };
};
