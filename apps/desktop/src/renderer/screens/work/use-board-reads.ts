import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import {
  buildArrivalKey,
  holdBackBoardChanges,
  type HeldChange,
  type WorkProject,
} from "@hercule/client-core/work";
import type { WorkBoard } from "@hercule/contract";
import { fadeInCards, riseArrival } from "./board-flights";
import { flipBoard } from "./flip-board";
import { useHeldChanges } from "./use-held-changes";
import "./motion.css";

const NOTHING_RELEASED: ReadonlySet<string> = new Set();

/** The board the screen draws, and what the reads did to it. */
export interface BoardReads {
  /** The board to draw, or `undefined` until the first read ends. */
  readonly board: WorkBoard | undefined;
  /** What the board did by itself last, such as "Review PR failed", for the toolbar's line. `null` when nothing is worth saying. */
  readonly note: string | null;
  /**
   * Tells the board that the user added the Task `taskId`. Its card then fades
   * into its cell on `travel` at once, instead of rising on `self` once the
   * user's hand is still.
   */
  readonly noteAddedTask: (taskId: string) => void;
}

/** What the board has drawn, the read it was made from, and the changes released when it was made. */
interface Picture {
  readonly board: WorkBoard;
  readonly server: WorkBoard | undefined;
  readonly released: ReadonlySet<string>;
}

/** What the screen gave `useBoardReads` at its last render. */
interface Inputs {
  readonly board: WorkBoard | undefined;
  readonly serverBoard: WorkBoard | undefined;
  readonly released: ReadonlySet<string>;
  readonly picture: Picture | undefined;
}

/** Returns the picture to draw next, and the changes it holds back until the hand is still. */
const decidePicture = (
  picture: Picture | undefined,
  board: WorkBoard,
  serverBoard: WorkBoard | undefined,
  released: ReadonlySet<string>,
): { readonly next: Picture; readonly held: readonly HeldChange[] } => {
  const decided =
    picture === undefined
      ? { board, held: [] }
      : holdBackBoardChanges(picture.board, board, released);
  return { next: { board: decided.board, server: serverBoard, released }, held: decided.held };
};

/**
 * Decides what the Work board draws from what it reads, and plays what a read
 * changes. `board` is the board with the user's pending moves applied and
 * `serverBoard` the board as the last read gave it; a change of the second is
 * a read, and a change of only the first is the user's own move.
 *
 * - A user's own move is drawn at once, in the render: the code that makes it
 *   plays it.
 * - A read is drawn right after the render that brought it. The board is
 *   measured then, before and after, and everything that moved glides on
 *   `self`, because nobody here caused it (`flipBoard`).
 * - A Task that arrives, and a run that fails, wait for a still hand
 *   (`useHeldChanges`), eight seconds at most. Until then the card is not
 *   drawn (an arrival) or keeps the look it had, so it does not rise to the
 *   top of its cell under the pointer (`holdBackBoardChanges`). Then the Task
 *   rises at the end of its cell on `self`, or the failing card takes the top
 *   of its cell, and the toolbar's line shows what happened. A Task that lies past what
 *   its cell shows, or under a folded lane, moves nothing: only the counts
 *   change.
 * - While a card is in the hand (`isCarrying`), nothing that nobody caused is
 *   drawn. It all shows when the card is let go, in the same change as the
 *   drop.
 * - A Task the user added (`noteAddedTask`) fades in on `travel` and waits
 *   for nothing.
 *
 * Nothing is measured unless a read changes what is drawn.
 */
export const useBoardReads = ({
  board,
  serverBoard,
  projects,
  isCarrying,
  scrollRef,
}: {
  readonly board: WorkBoard | undefined;
  readonly serverBoard: WorkBoard | undefined;
  readonly projects: readonly WorkProject[];
  readonly isCarrying: boolean;
  readonly scrollRef: RefObject<HTMLElement | null>;
}): BoardReads => {
  const [picture, setPicture] = useState<Picture | undefined>(undefined);
  const [released, setReleased] = useState(NOTHING_RELEASED);
  const [wasCarrying, setWasCarrying] = useState(false);
  if (wasCarrying !== isCarrying) setWasCarrying(isCarrying);

  // The drawn board is derived while rendering, and the picture is kept to
  // compare the next render with.
  let drawn = board;
  let held: readonly HeldChange[] = [];
  let isDeferred = false;
  if (board !== undefined) {
    const decided = decidePicture(picture, board, serverBoard, released);
    held = decided.held;
    const isRead =
      picture !== undefined && (serverBoard !== picture.server || released !== picture.released);
    // The render that ends a carry is the drop's own change, and it also
    // draws the reads that waited. Any other read is drawn after this render.
    const isShownNow = !isRead || (wasCarrying && !isCarrying);
    isDeferred = isRead && !isCarrying && !isShownNow;
    if (picture === undefined || isShownNow) {
      drawn = decided.next.board;
      if (picture === undefined || decided.next.board !== picture.board || isRead) {
        setPicture(decided.next);
      }
    } else {
      drawn = picture.board;
    }
  }

  const latest = useRef<Inputs>({ board, serverBoard, released, picture });
  const ownTaskIds = useRef(new Set<string>());
  useLayoutEffect(() => {
    latest.current = { board, serverBoard, released, picture };
  });

  // Draws a read: measures the board, commits the new picture, and plays what
  // moved. `flushSync` is refused inside a React lifecycle, so this runs from a
  // microtask, which comes before the browser paints.
  useLayoutEffect(() => {
    if (!isDeferred) return;
    let isCancelled = false;
    queueMicrotask(() => {
      if (isCancelled) return;
      const { board: latestBoard, serverBoard: latestServer, picture: shown } = latest.current;
      if (latestBoard === undefined || shown === undefined) return;
      const { next } = decidePicture(shown, latestBoard, latestServer, latest.current.released);
      const commit = (): void => {
        flushSync(() => {
          setPicture(next);
        });
      };
      const scroller = scrollRef.current;
      if (scroller === null || next.board === shown.board) {
        commit();
        return;
      }
      const shownIds = new Set(shown.board.cards.map((card) => card.id));
      const isAddedByUser = next.board.cards.some(
        (card) => !shownIds.has(card.id) && ownTaskIds.current.has(card.id),
      );
      const { born } = flipBoard(scroller, isAddedByUser ? "travel" : "self", commit);
      for (const card of born) {
        const id = card.dataset["cardId"];
        if (id === undefined) continue;
        const arrivalKey = buildArrivalKey(id);
        if (ownTaskIds.current.has(id)) fadeInCards([card], "travel");
        else if (next.released.has(arrivalKey) && !shown.released.has(arrivalKey))
          riseArrival(card);
        else fadeInCards([card], "self");
      }
    });
    return () => {
      isCancelled = true;
    };
  }, [isDeferred, serverBoard, released, scrollRef]);

  const note = useHeldChanges({
    held,
    board,
    projects,
    isCarrying,
    scrollRef,
    release: (key) => {
      setReleased((before) => new Set(before).add(key));
    },
  });

  const noteAddedTask = useCallback((taskId: string): void => {
    ownTaskIds.current.add(taskId);
    setReleased((before) => new Set(before).add(buildArrivalKey(taskId)));
  }, []);

  return { board: drawn, note, noteAddedTask };
};
