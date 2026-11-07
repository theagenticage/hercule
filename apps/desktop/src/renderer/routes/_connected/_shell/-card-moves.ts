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
 * - Several cards move or end as one gesture: `moveCards` for a drop of a
 *   group, `endCardsTogether` around several `endCard` calls. Each card is
 *   still its own request, sent in order by the same action. The gesture
 *   holds where every card stood before the first one moved, and Undo puts
 *   them back in the order they stood, so each lands after the card it
 *   followed.
 */
import { useRef, useSyncExternalStore, type RefObject } from "react";
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
  CARDS_ENDED_NOTE,
  describeCardEnd,
  describeCardEndFailure,
  describeCardsEnd,
  describeCardsLeftAsTheyAre,
  describeMoveFailure,
  readPlacement,
  reapplyCardChanges,
  type CardChange,
  type CardMove,
  type CardPlacement,
  type EndStage,
} from "@hercule/client-core/work";
import type { WorkBoard, WorkCard } from "@hercule/contract";
import type { SpringName } from "../../../app/motion";
import { buildStillSignedInCheck } from "../../../app/still-signed-in";
import type { CardMover, PutBackRequest } from "../../../app/card-mover";
import type { PendingCardMoves, PendingMove } from "../../../app/pending-card-moves";
import type { Gesture, UndoStack } from "../../../app/undo-stack";
import { useUndoLine, type UndoLineState } from "../../../app/use-undo-line";
import { launchLeavingCard, sendLeavingCard } from "../../../screens/work/board-flights";
import { flipBoard } from "../../../screens/work/flip-board";
import { workBoardQuery } from "./-work-board";

/**
 * A pending move with the check that the user who made it is still signed in.
 * The move waits in a queue and its answer arrives later, and both can happen
 * after a sign-out.
 */
interface QueuedMove {
  readonly request: PendingMove;
  readonly isStillSignedIn: () => boolean;
}

/** The key every card move runs under, so the moves can be counted. */
const CARD_MOVES_KEY = ["card-moves"];

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
  /**
   * Moves several cards as one gesture: one request for each move, sent in
   * order, and one Undo that puts them all back. The board jumps to the new
   * places, as for `moveCard`. `moves` are applied in order, each over the
   * board the ones before it left. A move that changes nothing is left out.
   * `describe` is given the moves that remain, and returns the words for the
   * undo line. Does nothing when no move remains.
   */
  readonly moveCards: (
    moves: readonly CardMove[],
    describe: (moves: readonly CardMove[]) => string,
    note?: string,
  ) => void;
  /**
   * Runs `act`, which marks cards Done or Dropped (`stage`) by calling
   * `endCard`, and offers one Undo for all the cards it ended instead of one
   * for each. The undo line says how many, such as "Marked 3 Tasks Done".
   */
  readonly endCardsTogether: (stage: EndStage, act: () => void) => void;
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

/** What Undo says when it has nothing to put back, for a gesture of one card or of several. */
interface UndoRefusals {
  readonly missing: string;
  readonly notSaved: string;
}

/** Returns what Undo says when a gesture that moved `count` cards has nothing to put back. */
const describeMoveRefusals = (count: number): UndoRefusals =>
  count === 1
    ? { missing: "The card is no longer on the board.", notSaved: NOT_SAVED_MESSAGE }
    : {
        missing: "The cards are no longer on the board.",
        notSaved: "Those moves did not save, so there is nothing to put back.",
      };

/** Returns what Undo says when a gesture that ended `count` cards has nothing to put back. */
const describeEndRefusals = (count: number): UndoRefusals =>
  count === 1
    ? { missing: "The Task is already back on the board.", notSaved: END_NOT_SAVED_MESSAGE }
    : {
        missing: "The Tasks are already back on the board.",
        notSaved: "Those updates did not save, so there is nothing to put back.",
      };

/** One card's share of a gesture: whether its request was saved, and how Undo puts that card back. */
interface UndoPart {
  readonly wasSaved: Promise<boolean>;
  readonly putBack: (mover: CardMover) => PutBackRequest | undefined;
}

/** Cards ending together as one gesture: the board before the first one ended, and what each one left. */
interface EndGroup {
  readonly startBoard: WorkBoard;
  readonly ended: { readonly card: WorkCard; readonly part: UndoPart }[];
}

/**
 * Runs `act` with `group` held in `holder`, so the cards that `endCard` ends
 * meanwhile join the group, and empties `holder` again even when `act` throws.
 * It is not written inline in the hook because the React Compiler cannot
 * compile a `try` without a `catch`.
 */
const runInEndGroup = (
  holder: { current: EndGroup | null },
  group: EndGroup,
  act: () => void,
): void => {
  holder.current = group;
  try {
    act();
  } finally {
    holder.current = null;
  }
};

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
  pendingMoves,
  serverBoard,
  scrollRef,
  onCardReturning,
}: {
  readonly client: HerculeClient;
  readonly undoStack: UndoStack<CardMover>;
  /** The moves the controller has not answered yet. They outlive this screen. */
  readonly pendingMoves: PendingCardMoves;
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
  // A gesture reads the store's snapshot directly, so two gestures before one
  // render see each other's move. `shownMoves` is what this render draws.
  const shownMoves = useSyncExternalStore(pendingMoves.subscribe, pendingMoves.getSnapshot);
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
          pendingMoves.getSnapshot().map((each) => each.change),
        );
  };

  const { mutateAsync } = useMutation({
    mutationKey: CARD_MOVES_KEY,
    // A move in a scope waits for the one before it to finish before it is sent.
    scope: { id: "card-moves" },
    // Resolves to false when the move was not sent because it undoes a move
    // that did not save, or because the user who made it signed out. The client
    // sends the token it holds when it is called, so a move sent after a
    // sign-out would go out as the next account.
    mutationFn: async ({ request, isStillSignedIn }: QueuedMove): Promise<boolean> => {
      const { change, isUndoWanted } = request;
      if (!isStillSignedIn()) return false;
      if (isUndoWanted !== undefined && !(await isUndoWanted)) return false;
      if (!isStillSignedIn()) return false;
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
    onSuccess: async (isSent, { request, isStillSignedIn }) => {
      if (isSent && isStillSignedIn()) {
        // A read that started before this answer could end after the patch and
        // put the card back. Cancelling reverts it, and the push that follows
        // starts a read that began after the answer.
        await queryClient.cancelQueries({ queryKey: queryKeys.workBoard() });
        // The cache may belong to the next account by now. Its board has not
        // seen this move, and the move's card is the previous account's.
        if (isStillSignedIn()) {
          queryClient.setQueryData<WorkBoard>(queryKeys.workBoard(), (cached) =>
            cached === undefined ? undefined : applyCardChange(cached, request.change),
          );
        }
      }
      // Right after the patch, with no wait between, so React draws the
      // patched board and the shorter list together.
      pendingMoves.remove(request);
    },
    onError: (error, { request, isStillSignedIn }) => {
      const { change } = request;
      // The undo line and the card belong to the next account by now.
      if (!isStillSignedIn()) {
        pendingMoves.remove(request);
        return;
      }
      if (change.kind === "end") onCardReturning(change.card.id, change.stage);
      playBoardChange("travel", () => {
        pendingMoves.remove(request);
      });
      say(
        change.kind === "end"
          ? describeCardEndFailure(change.card, change.stage, readErrorMessage(error))
          : describeMoveFailure(readErrorMessage(error)),
        false,
      );
    },
    // Runs after the answer or the error. The move being settled still counts
    // as a running mutation, so it is the last one when the count is one.
    onSettled: (_isSent, _error, { isStillSignedIn }) => {
      if (!isStillSignedIn() || queryClient.isMutating({ mutationKey: CARD_MOVES_KEY }) !== 1) {
        return;
      }
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
    const request: PendingMove = { change, isUndoWanted };
    const queued: QueuedMove = { request, isStillSignedIn: buildStillSignedInCheck(client) };
    if (isPlayed) {
      playBoardChange("hand", () => {
        pendingMoves.add(request);
      });
    } else {
      pendingMoves.add(request);
    }
    onShown?.();
    return mutateAsync(queued);
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
   * the undo line. Each of `parts` is one card: `putBack` asks the open
   * screen to bring that card back. The cards are queued back in the order
   * of `parts`, so a card that follows another lands after it. A part whose
   * request failed has nothing to reverse; when none of them has, the gesture
   * is taken off the stack again, because the next Undo is for the gesture
   * before it.
   */
  const offerUndo = (
    words: string,
    note: string | undefined,
    parts: readonly UndoPart[],
    refusals: UndoRefusals,
  ): void => {
    const gesture: Gesture<CardMover> = {
      words,
      undo: async (mover) => {
        // Every card is queued before any is awaited, so each sees the ones before it back in place.
        const requests = parts.flatMap((part) => {
          const request = part.putBack(mover);
          return request === undefined ? [] : [request];
        });
        if (requests.length === 0) throw new Error(refusals.missing);
        await Promise.all(requests.map((each) => each.request));
        const saved = await Promise.all(parts.map((part) => part.wasSaved));
        if (!saved.some(Boolean)) throw new Error(refusals.notSaved);
        const notes = [
          requests.every((each) => each.isExact) ? undefined : CARD_NOT_EXACT_NOTE,
          requests.length === parts.length
            ? undefined
            : describeCardsLeftAsTheyAre(parts.length - requests.length),
        ].filter((each) => each !== undefined);
        return notes.length === 0 ? undefined : notes.join(" ");
      },
    };
    undoStack.push(gesture);
    say(note === undefined ? `${words}.` : `${words}. ${note}`, true);
    void Promise.all(parts.map((part) => part.wasSaved)).then((saved) => {
      if (!saved.some(Boolean)) undoStack.remove(gesture);
    });
  };

  // Set while `endCardsTogether` runs, so the cards `endCard` ends join one gesture.
  const endGroup = useRef<EndGroup | null>(null);

  const endCard = (taskId: string, stage: EndStage): void => {
    const board = readShownBoard();
    const card = board?.cards.find((each) => each.id === taskId);
    // Cards ending together are put back where they stood before the first one ended.
    const group = endGroup.current;
    const from =
      board === undefined ? undefined : readPlacement(group?.startBoard ?? board, taskId);
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
    const part: UndoPart = {
      wasSaved,
      putBack: (mover) => mover.putEndedCardBack(card, from, stage, wasSaved),
    };
    if (group === null) {
      offerUndo(describeCardEnd(card, stage), CARD_ENDED_NOTE, [part], describeEndRefusals(1));
    } else {
      group.ended.push({ card, part });
    }
  };

  const endCardsTogether = (stage: EndStage, act: () => void): void => {
    const startBoard = readShownBoard();
    if (startBoard === undefined || endGroup.current !== null) {
      act();
      return;
    }
    const group: EndGroup = { startBoard, ended: [] };
    runInEndGroup(endGroup, group, act);
    // Put back in the order the cards stood, so each lands after the card it followed.
    const indexOf = (card: WorkCard): number =>
      startBoard.cards.findIndex((each) => each.id === card.id);
    const ended = group.ended.toSorted((a, b) => indexOf(a.card) - indexOf(b.card));
    const [only] = ended;
    if (only === undefined) return;
    const parts = ended.map((each) => each.part);
    if (ended.length === 1) {
      offerUndo(describeCardEnd(only.card, stage), CARD_ENDED_NOTE, parts, describeEndRefusals(1));
    } else {
      offerUndo(
        describeCardsEnd(ended.length, stage),
        CARDS_ENDED_NOTE,
        parts,
        describeEndRefusals(ended.length),
      );
    }
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
    offerUndo(
      words,
      note,
      [{ wasSaved, putBack: (mover) => mover.putCardBack(from, wasSaved) }],
      describeMoveRefusals(1),
    );
  };

  const moveCard = (move: CardMove, words: string, note?: string): void => {
    makeMove(move, words, note, false);
  };

  const moveCards = (
    moves: readonly CardMove[],
    describe: (moves: readonly CardMove[]) => string,
    note?: string,
  ): void => {
    const original = readShownBoard();
    if (original === undefined) return;
    const sent: { readonly move: CardMove; readonly part: UndoPart }[] = [];
    for (const move of moves) {
      // Undo puts the card back where it stood before the first card of the
      // group moved. Whether the card needs to move at all depends on where
      // it stands now, after the cards before it have moved.
      const from = readPlacement(original, move.taskId);
      const board = readShownBoard();
      if (from === undefined || board === undefined) continue;
      const stands = readPlacement(board, move.taskId);
      if (stands === undefined) continue;
      if (isSamePlace(stands, readPlacement(applyCardMove(board, move), move.taskId))) continue;
      const wasSaved = sendMove(move, false).then(
        () => true,
        () => false,
      );
      sent.push({
        move,
        part: { wasSaved, putBack: (mover) => mover.putCardBack(from, wasSaved) },
      });
    }
    if (sent.length === 0) return;
    // Put back in the order the cards stood, so each lands after the card it followed.
    const indexOf = ({ move }: { readonly move: CardMove }): number =>
      original.cards.findIndex((each) => each.id === move.taskId);
    offerUndo(
      describe(sent.map((each) => each.move)),
      note,
      sent.toSorted((a, b) => indexOf(a) - indexOf(b)).map((each) => each.part),
      describeMoveRefusals(sent.length),
    );
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
            shownMoves.map((each) => each.change),
          ),
    moveCard,
    moveCardWithMotion,
    moveCards,
    endCard,
    endCardsTogether,
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
