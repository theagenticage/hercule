import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import {
  buildArrivalKey,
  buildStageMoveKey,
  holdBackBoardChanges,
  planMorningReplay,
  type BoardSnapshot,
  type EndStage,
  type HeldChange,
  type WorkProject,
} from "@hercule/client-core/work";
import type { WorkBoard } from "@hercule/contract";
import { isMotionReduced } from "../../app/motion";
import { fadeInCards, returnCard, riseArrival } from "./board-flights";
import { prepareSelfMoves, type SelfMovingCard } from "./fact-move";
import { flipBoard } from "./flip-board";
import { buildReplayDelays } from "./morning-replay";
import { useHeldChanges } from "./use-held-changes";
import "./motion.css";

const NOTHING_RELEASED: ReadonlySet<string> = new Set();
const NO_KEYS: readonly string[] = [];
const NO_PLAYED_KEYS: ReadonlySet<string> = new Set();

/** The board the screen draws, and what the reads did to it. */
export interface BoardReads {
  /**
   * The drawn board: the logical board with the changes nobody here caused
   * held back. Only what the screen draws reads it (the lanes, the Filter,
   * Find, the counts); every action reads the logical board. `undefined`
   * until the first read ends.
   */
  readonly drawnBoard: WorkBoard | undefined;
  /** What the board did by itself last, such as "Review PR failed", for the toolbar's line. `null` when nothing is worth saying. */
  readonly note: string | null;
  /**
   * Tells the board that the user added the Task `taskId`. Its card then fades
   * into its cell on `travel` at once, instead of rising on `self` once the
   * user's hand is still.
   */
  readonly noteAddedTask: (taskId: string) => void;
  /**
   * Tells the board that the card of `taskId`, which was marked Done or
   * Dropped (`how`), is about to be drawn again, because the user pressed Undo
   * or the update was refused. The card is then let in at once and plays its
   * way back (`returnCard`), instead of waiting for a still hand as a Task
   * that arrived by itself does.
   */
  readonly noteReturnedTask: (taskId: string, how: EndStage) => void;
  /**
   * What changed since the user last looked, such as "Since you last looked:
   * two landed, one new", once the morning replay has played (at once under
   * Reduce motion, where nothing plays). `null` when nothing changed, or
   * while the replay still plays.
   */
  readonly sinceLastLook: string | null;
  /** Plays the morning replay again, or `null` when there was none to play. */
  readonly playReplayAgain: (() => void) | null;
}

/** What the board has drawn, the read it was made from, and the changes released when it was made. */
interface Picture {
  readonly board: WorkBoard;
  readonly server: WorkBoard | undefined;
  readonly released: ReadonlySet<string>;
  /** The Tasks the logical board left out when this picture was made. */
  readonly hidden: ReadonlySet<string>;
}

/**
 * What the morning replay of this visit plays: the sentence that tells what
 * changed, and the keys of the changes it plays, oldest first (empty when
 * nothing plays, as under Reduce motion).
 */
interface VisitReplay {
  readonly summary: string;
  readonly playedKeys: readonly string[];
}

/** What the screen gave `useBoardReads` at its last render. */
interface Inputs {
  readonly logicalBoard: WorkBoard | undefined;
  readonly hiddenIds: ReadonlySet<string>;
  readonly movedIds: ReadonlySet<string>;
  readonly serverBoard: WorkBoard | undefined;
  readonly released: ReadonlySet<string>;
  readonly picture: Picture | undefined;
  readonly playedKeys: ReadonlySet<string>;
  readonly isCarrying: boolean;
}

/** What `decidePicture` reads of the screen's inputs. */
type PictureInputs = Omit<Inputs, "logicalBoard" | "picture" | "isCarrying">;

/**
 * Returns the picture to draw next, and the changes it holds back until the
 * hand is still. The first picture is `logicalBoard` itself, unless the
 * morning replay starts from `replayStart`, the board it plays forward from.
 */
const decidePicture = (
  picture: Picture | undefined,
  replayStart: WorkBoard | undefined,
  logicalBoard: WorkBoard,
  inputs: PictureInputs,
): { readonly next: Picture; readonly held: readonly HeldChange[] } => {
  const { hiddenIds, movedIds, serverBoard, released, playedKeys } = inputs;
  const shown = picture?.board ?? replayStart;
  const decided =
    shown === undefined
      ? { board: logicalBoard, held: [] }
      : holdBackBoardChanges(shown, logicalBoard, {
          released,
          hiddenBefore: picture?.hidden ?? hiddenIds,
          playedKeys,
          movedByUser: movedIds,
        });
  return {
    next: { board: decided.board, server: serverBoard, released, hidden: hiddenIds },
    held: decided.held,
  };
};

/**
 * Decides what the Work board draws from what it reads, and plays what a read
 * changes. `logicalBoard` is the board with everything the user did applied
 * (`buildLogicalBoard`), `hiddenIds` the Tasks it left out on purpose, and
 * `serverBoard` the board as the last read gave it; a change of the last is a
 * read, and a change of only the logical board is the user's own change.
 * `snapshot` is the board as the user last saw it, if the app kept one.
 * Returns the drawn board.
 *
 * - A user's own move is drawn at once, in the render: the code that makes it
 *   plays it.
 * - A read is drawn right after the render that brought it. The board is
 *   measured then, before and after, and everything that moved glides on
 *   `self`, because nobody here caused it (`flipBoard`).
 * - A Task that arrives, a run that fails, and a card that a fact moves wait
 *   for a still hand (`useHeldChanges`), eight seconds at most. Until then the
 *   card is not drawn (an arrival) or keeps the look it had, so it does not
 *   rise to the top of its cell, or cross the board, under the pointer
 *   (`holdBackBoardChanges`). Then the Task rises at the end of its cell on
 *   `self`, or the failing card takes the top of its cell, or the card that a
 *   fact moved shows its cause and crosses to the end of its new cell
 *   (`prepareSelfMoves`), and the toolbar's line shows what happened. A Task
 *   that lies past what its cell shows, or under a folded lane, moves
 *   nothing: only the counts change.
 * - While a card is in the hand (`isCarrying`), nothing that nobody caused is
 *   drawn. It all shows when the card is let go, in the same change as the
 *   drop.
 * - A Task the user added (`noteAddedTask`) fades in on `travel` and waits
 *   for nothing.
 * - The first picture of a visit starts from `snapshot` when it differs from
 *   the first read, and the changes between them play in turn as above, 1.5
 *   seconds apart (the morning replay, `planMorningReplay`). Under Reduce
 *   motion nothing plays: the board is drawn at once and `sinceLastLook`
 *   says what changed.
 *
 * Nothing is measured unless a read changes what is drawn.
 */
export const useBoardReads = ({
  logicalBoard,
  hiddenIds,
  movedIds,
  serverBoard,
  snapshot,
  projects,
  groupBy,
  isCarrying,
  scrollRef,
}: {
  readonly logicalBoard: WorkBoard | undefined;
  readonly hiddenIds: ReadonlySet<string>;
  /** The Tasks whose stage the user moved and the controller has not answered yet. They are never held back (`LogicalBoard.movedIds`). */
  readonly movedIds: ReadonlySet<string>;
  readonly serverBoard: WorkBoard | undefined;
  readonly snapshot: BoardSnapshot | undefined;
  readonly projects: readonly WorkProject[];
  /** How the board is grouped, as the view saved it. */
  readonly groupBy: string;
  readonly isCarrying: boolean;
  readonly scrollRef: RefObject<HTMLElement | null>;
}): BoardReads => {
  const [picture, setPicture] = useState<Picture | undefined>(undefined);
  const [visitReplay, setVisitReplay] = useState<VisitReplay | undefined>(undefined);
  const [released, setReleased] = useState(NOTHING_RELEASED);
  const [wasCarrying, setWasCarrying] = useState(false);
  if (wasCarrying !== isCarrying) setWasCarrying(isCarrying);

  // The drawn board is derived while rendering, and the picture is kept to
  // compare the next render with.
  let drawn = logicalBoard;
  let held: readonly HeldChange[] = [];
  let isDeferred = false;
  let playedKeys = visitReplay === undefined ? NO_PLAYED_KEYS : new Set(visitReplay.playedKeys);
  if (logicalBoard !== undefined) {
    // The first picture of a visit, which is also the first one after the
    // replay is asked for again, may start from how the board looked.
    let replayStart: WorkBoard | undefined;
    if (picture === undefined) {
      const plan = snapshot === undefined ? undefined : planMorningReplay(snapshot, logicalBoard);
      const isPlayed = plan !== undefined && !isMotionReduced();
      replayStart = isPlayed ? plan.shown : undefined;
      playedKeys = isPlayed ? new Set(plan.playedKeys) : NO_PLAYED_KEYS;
      setVisitReplay(
        plan === undefined
          ? undefined
          : { summary: plan.summary, playedKeys: isPlayed ? plan.playedKeys : NO_KEYS },
      );
    }
    const decided = decidePicture(picture, replayStart, logicalBoard, {
      hiddenIds,
      movedIds,
      serverBoard,
      released,
      playedKeys,
    });
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

  const latest = useRef<Inputs>({
    logicalBoard,
    hiddenIds,
    movedIds,
    serverBoard,
    released,
    picture,
    playedKeys,
    isCarrying,
  });
  const ownTaskIds = useRef(new Set<string>());
  const returnedTasks = useRef(new Map<string, EndStage>());
  // Stops what a read started and has not finished, such as a dent that waits
  // to close, when the screen goes. Made in a layout effect so that the first
  // draw, which comes from a microtask queued by a later one, can use it.
  const lifetime = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
    };
  }, []);
  useLayoutEffect(() => {
    latest.current = {
      logicalBoard,
      hiddenIds,
      movedIds,
      serverBoard,
      released,
      picture,
      playedKeys,
      isCarrying,
    };
  });

  // Draws a read: measures the board, commits the new picture, and plays what
  // moved. `flushSync` is refused inside a React lifecycle, so this runs from a
  // microtask, which comes before the browser paints.
  useLayoutEffect(() => {
    if (!isDeferred) return;
    let isCancelled = false;
    queueMicrotask(() => {
      if (isCancelled) return;
      const {
        logicalBoard: latestBoard,
        hiddenIds: latestHidden,
        movedIds: latestMoved,
        serverBoard: latestServer,
        picture: shown,
      } = latest.current;
      if (latestBoard === undefined || shown === undefined) return;
      const { next } = decidePicture(shown, undefined, latestBoard, {
        hiddenIds: latestHidden,
        movedIds: latestMoved,
        serverBoard: latestServer,
        released: latest.current.released,
        playedKeys: latest.current.playedKeys,
      });
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
      const shownCards = new Map(shown.board.cards.map((card) => [card.id, card]));
      const isCausedByUser = next.board.cards.some(
        (card) =>
          !shownCards.has(card.id) &&
          (ownTaskIds.current.has(card.id) || returnedTasks.current.has(card.id)),
      );
      // A card whose move was released by this read crosses by itself, with
      // its cause and its dent.
      const selfMoves = next.board.cards.flatMap((card): SelfMovingCard[] => {
        const key = buildStageMoveKey(card);
        const before = shownCards.get(card.id);
        return before !== undefined &&
          before.stage !== card.stage &&
          next.released.has(key) &&
          !shown.released.has(key)
          ? [{ cardId: card.id, stage: card.stage, cause: card.stageCause?.text }]
          : [];
      });
      const moves = prepareSelfMoves(scroller, selfMoves);
      const { born } = flipBoard(scroller, isCausedByUser ? "travel" : "self", () => {
        moves.keepPlaces();
        commit();
      });
      moves.play({
        isDragging: () => latest.current.isCarrying,
        signal: lifetime.current?.signal ?? new AbortController().signal,
      });
      for (const card of born) {
        const id = card.dataset["cardId"];
        if (id === undefined) continue;
        const arrivalKey = buildArrivalKey(id);
        const returnedHow = returnedTasks.current.get(id);
        if (returnedHow !== undefined) {
          returnCard(scroller, card, returnedHow, card.dataset["stage"] ?? "");
        } else if (ownTaskIds.current.has(id)) fadeInCards([card], "travel");
        else if (next.released.has(arrivalKey) && !shown.released.has(arrivalKey))
          riseArrival(card);
        else fadeInCards([card], "self");
      }
      returnedTasks.current.clear();
    });
    return () => {
      isCancelled = true;
    };
  }, [isDeferred, serverBoard, released, scrollRef]);

  const note = useHeldChanges({
    held,
    board: logicalBoard,
    projects,
    groupBy,
    isCarrying,
    scrollRef,
    release: (key) => {
      setReleased((before) => new Set(before).add(key));
    },
    startDelays: buildReplayDelays(visitReplay?.playedKeys ?? NO_KEYS),
  });

  const noteAddedTask = useCallback((taskId: string): void => {
    ownTaskIds.current.add(taskId);
    setReleased((before) => new Set(before).add(buildArrivalKey(taskId)));
  }, []);

  const noteReturnedTask = useCallback((taskId: string, how: EndStage): void => {
    returnedTasks.current.set(taskId, how);
    setReleased((before) => new Set(before).add(buildArrivalKey(taskId)));
  }, []);

  // Starting again from the first picture draws the replay from the snapshot.
  const playReplayAgain = useCallback((): void => {
    setPicture(undefined);
    setReleased(NOTHING_RELEASED);
  }, []);

  const isReplaying =
    visitReplay !== undefined && held.some((change) => visitReplay.playedKeys.includes(change.key));
  return {
    drawnBoard: drawn,
    note,
    noteAddedTask,
    noteReturnedTask,
    sinceLastLook: visitReplay === undefined || isReplaying ? null : visitReplay.summary,
    playReplayAgain:
      visitReplay !== undefined && visitReplay.playedKeys.length > 0 ? playReplayAgain : null,
  };
};
