import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { NO_PROJECT_LANE_ID } from "@hercule/client-core/work";
import type { WorkBoard, WorkCard } from "@hercule/contract";
import { waitForStillHand } from "../../app/motion";
import { glideFromLayouts, measureBoardLayouts, type BoardLayouts } from "./board-layouts";
import { fadeInCards, riseArrival } from "./board-flights";
import { buildArrivalKey, holdBackBoardChanges, type HeldChange } from "./hold-back-board";
import "./motion.css";

/** How long the toolbar's line keeps saying what happened by itself, in milliseconds. */
const NOTE_SHOWN_MS = 10_000;

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

/** What the board has shown, and the read it was made from. */
interface Picture {
  readonly board: WorkBoard;
  readonly server: WorkBoard | undefined;
}

/** Returns whether a card is in the hand, from the mark the drag puts on the desk, and re-renders when it changes. */
const useIsCarrying = (scrollRef: RefObject<HTMLElement | null>): boolean => {
  const [isCarrying, setIsCarrying] = useState(false);
  useEffect(() => {
    const desk = scrollRef.current?.closest(".work-desk");
    if (desk === null || desk === undefined) return;
    const watcher = new MutationObserver(() => {
      setIsCarrying(desk.hasAttribute("data-carrying"));
    });
    watcher.observe(desk, { attributes: true, attributeFilter: ["data-carrying"] });
    return () => {
      watcher.disconnect();
    };
  }, [scrollRef]);
  return isCarrying;
};

/** Returns the element a held change would happen at: the failing card, or the cell where the new Task would land. */
const findChangeTarget = (
  scroller: HTMLElement | null,
  change: HeldChange,
  card: WorkCard | undefined,
): Element | null => {
  if (scroller === null) return null;
  if (change.kind === "failure") return scroller.querySelector(`[data-card-id="${change.cardId}"]`);
  if (card === undefined) return null;
  const lanes = [card.projectId, NO_PROJECT_LANE_ID];
  for (const lane of lanes) {
    if (lane === undefined) continue;
    const cell = scroller.querySelector(`[data-lane-id="${lane}"][data-stage="${card.stage}"]`);
    if (cell !== null) return cell;
  }
  return null;
};

/** Returns the sentence for the toolbar's line when `change` shows, or `null` when the card is gone. */
const describeChange = (change: HeldChange, card: WorkCard | undefined): string | null => {
  if (card === undefined) return null;
  return change.kind === "arrival"
    ? `New: ${card.title}`
    : `${card.failure?.workflowName ?? "A run"} failed`;
};

/**
 * Decides what the Work board draws from what it reads, and plays what a read
 * changes. `board` is the board with the user's pending moves applied and
 * `serverBoard` the board as the last read gave it; the first tells the
 * second's changes from the user's own.
 *
 * - A Task that arrives, and a run that fails, wait for a still hand
 *   (`waitForStillHand`), eight seconds at most. Until then the card is not
 *   drawn (an arrival) or keeps the look it had, so it does not rise to the
 *   top of its cell under the pointer (`holdBackBoardChanges`). Then the Task
 *   rises at the end of its cell on `self`, or the failing card takes the top
 *   of its cell, and the toolbar's line says so. A Task that lies past what
 *   its cell shows, or under a folded lane, moves nothing: only the counts
 *   change.
 * - Any other change a read brings glides on `self`, because nobody here
 *   caused it. A move the user makes is not a read: the code that makes it
 *   plays it.
 * - While a card is in the hand, a read is not drawn. It shows after the
 *   drop, as one change.
 * - A Task the user added (`noteAddedTask`) fades in on `travel` and waits
 *   for nothing.
 */
export const useBoardReads = ({
  board,
  serverBoard,
  scrollRef,
}: {
  readonly board: WorkBoard | undefined;
  readonly serverBoard: WorkBoard | undefined;
  readonly scrollRef: RefObject<HTMLElement | null>;
}): BoardReads => {
  const [picture, setPicture] = useState<Picture | undefined>(undefined);
  const [released, setReleased] = useState(NOTHING_RELEASED);
  const [note, setNote] = useState<{ readonly text: string } | null>(null);
  const isCarrying = useIsCarrying(scrollRef);

  // Which of the board's changes to draw now. This is derived while rendering,
  // and the picture is kept to compare the next read with.
  let drawn = board;
  let held: readonly HeldChange[] = [];
  if (board !== undefined) {
    const decided =
      picture === undefined
        ? { board, held }
        : holdBackBoardChanges(picture.board, board, released);
    held = decided.held;
    // A read that lands while a card is in the hand waits for the drop.
    const isFrozen = picture !== undefined && isCarrying && serverBoard !== picture.server;
    drawn = isFrozen ? picture.board : decided.board;
    if (!isFrozen && (decided.board !== picture?.board || serverBoard !== picture?.server)) {
      setPicture({ board: decided.board, server: serverBoard });
    }
  }

  // The board as read, not as drawn: a held card is only in this one.
  const latest = useRef({ board, held });
  useEffect(() => {
    latest.current = { board, held };
  });
  const ownTaskIds = useRef(new Set<string>());
  const justReleased = useRef(new Map<string, HeldChange>());

  // ---------- Waiting for a still hand ----------
  const waits = useRef(new Map<string, AbortController>());
  const heldKeys = held.map((change) => change.key).join("|");
  useEffect(() => {
    const wanted = new Map(latest.current.held.map((change) => [change.key, change]));
    for (const [key, controller] of waits.current) {
      if (wanted.has(key)) continue;
      controller.abort();
      waits.current.delete(key);
    }
    for (const [key, change] of wanted) {
      if (waits.current.has(key)) continue;
      const controller = new AbortController();
      waits.current.set(key, controller);
      const findCard = (): WorkCard | undefined =>
        latest.current.board?.cards.find((each) => each.id === change.cardId);
      void waitForStillHand({
        target: () => findChangeTarget(scrollRef.current, change, findCard()),
        isDragging: () =>
          scrollRef.current?.closest(".work-desk")?.hasAttribute("data-carrying") === true,
        signal: controller.signal,
      }).then((isStill) => {
        if (!isStill) return;
        waits.current.delete(key);
        justReleased.current.set(key, change);
        setReleased((before) => new Set(before).add(key));
        const text = describeChange(change, findCard());
        if (text !== null) setNote({ text });
      });
    }
  }, [heldKeys, scrollRef]);
  useEffect(() => {
    const running = waits.current;
    return () => {
      for (const controller of running.values()) controller.abort();
      running.clear();
    };
  }, []);

  // ---------- The toolbar's line ----------
  useEffect(() => {
    if (note === null) return;
    const timer = setTimeout(() => {
      setNote(null);
    }, NOTE_SHOWN_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [note]);

  // ---------- Playing what a read changed ----------
  const layouts = useRef<BoardLayouts | null>(null);
  const seen = useRef<{ drawn: WorkBoard | undefined; server: WorkBoard | undefined }>({
    drawn: undefined,
    server: undefined,
  });
  const isWaitingForDrop = useRef(false);
  // No dependency list: the board is measured after every commit, so the next
  // read starts from where the cards stand.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const wasRead = serverBoard !== seen.current.server;
    const hasChanged = drawn !== seen.current.drawn;
    const before = layouts.current;
    const isPlayed =
      scroller !== null &&
      before !== null &&
      seen.current.drawn !== undefined &&
      hasChanged &&
      (wasRead || justReleased.current.size > 0 || isWaitingForDrop.current);
    if (isPlayed) {
      const arrived = new Set(
        [...justReleased.current.values()]
          .filter((change) => change.kind === "arrival" && !ownTaskIds.current.has(change.cardId))
          .map((change) => change.cardId),
      );
      // A Task the user added is something they asked for: all of it plays on `travel`.
      const isAddedByUser = [...ownTaskIds.current].some(
        (id) =>
          !before.parts.has(`card:${id}`) &&
          scroller.querySelector(`[data-card-id="${id}"]`) !== null,
      );
      const born = glideFromLayouts(scroller, before, isAddedByUser ? "travel" : "self");
      for (const card of born) {
        const id = card.dataset["cardId"] ?? "";
        if (arrived.has(id)) riseArrival(card);
        else if (ownTaskIds.current.has(id)) fadeInCards([card], "travel");
        else fadeInCards([card], "self");
      }
      isWaitingForDrop.current = false;
    } else if (wasRead && isCarrying) {
      isWaitingForDrop.current = true;
    }
    justReleased.current.clear();
    seen.current = { drawn, server: serverBoard };
    layouts.current = scroller === null ? null : measureBoardLayouts(scroller);
  });

  const noteAddedTask = useCallback((taskId: string): void => {
    ownTaskIds.current.add(taskId);
    setReleased((before) => new Set(before).add(buildArrivalKey(taskId)));
  }, []);

  return { board: drawn, note: note?.text ?? null, noteAddedTask };
};
