/**
 * A card moving by itself, from the moment it is released to the moment it has
 * arrived. One module owns the whole sequence, so the order of its parts is in
 * one place:
 *
 * 1. `announce`: once the hand is still, the cause lands on the card as a
 *    label and holds for 760ms. A drag that begins meanwhile makes it wait for
 *    the drop.
 * 2. `noteReleased`: the board hands back the change it released.
 * 3. `draw`: the board commits the read that moves the card. The card crosses
 *    to the end of its new cell on `self`, wearing the same label; the place it
 *    left stays open as a dent; a card that is now only a line ("3 landed", a
 *    folded lane's count) fades on the way into that line; and the dent closes
 *    once the hand is out of its lane.
 *
 * Everything here moves `transform` and `opacity` only, through the motion
 * kernel.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { listCardMoves, type DropPlace, type HeldChange } from "@hercule/client-core/work";
import type { BoardStage, WorkBoard } from "@hercule/contract";
import {
  isMotionReduced,
  pauseFor,
  waitForVisibleStillHand,
  type FlipByKeyResult,
  type SpringName,
} from "../../app/motion";
import { openDent, showCauseLabel, type CauseLabels } from "../desk";
import {
  fadeInCards,
  flyFlightsTo,
  INTO_PLACE,
  launchFlights,
  removeFlight,
} from "./board-flights";
import { findCardElement } from "./card-in-lane";
import { flipBoard } from "./flip-board";
import { findHidingPlace } from "./land-card";
import type { HeldContext } from "./use-held-changes";

/** How long the cause label stays on a card before the card moves, in milliseconds. Under Reduce motion the card does not travel, so the label only needs to be seen. */
const CAUSE_HELD_MS = 760;
const CAUSE_HELD_REDUCED_MS = 80;

/**
 * How long a card keeps its cause label and stands above the cards it passes
 * after it starts to cross, in milliseconds. A little longer than the
 * crossing, which takes about a second on `self`.
 */
const CROSSING_MS = 1400;

/** How long the dent keeps the old place open at least, in milliseconds. */
const DENT_HOLD_MS = 1500;

/** The longest the dent stays open for a hand that rests in its lane, in milliseconds. */
const DENT_LONGEST_WAIT_MS = 60_000;

/** A card that moves by itself in one draw of the board. */
interface SelfMove {
  readonly cardId: string;
  /** The stage the card moves to. */
  readonly stage: BoardStage;
  /** The label that was shown for the move, or `undefined` when nothing says why. */
  readonly labels: CauseLabels | undefined;
}

/** What the hook gives the board. */
export interface SelfMoves {
  /**
   * Shows why a held change that moves a card is about to happen, and holds
   * for a moment. Resolves `true` when the change may be released, `false`
   * when it was cancelled. Resolves `true` at once for any other change, and
   * for a move with no cause.
   */
  readonly announce: (change: HeldChange, context: HeldContext) => Promise<boolean>;
  /** Tells that `change` was released, so the next `draw` plays it as a card moving by itself. */
  readonly noteReleased: (change: HeldChange) => void;
  /**
   * Commits a read of the board with `commit` and moves everything that
   * moved from where it was to where it is, on `spring` (`flipBoard`). A card
   * that was released (`noteReleased`) and changed stage between `shown` and
   * `next` moves by itself, as the sequence above says. Returns what
   * `flipBoard` returns.
   */
  readonly draw: (
    scroller: HTMLElement,
    boards: { readonly shown: WorkBoard; readonly next: WorkBoard },
    spring: SpringName,
    commit: () => void,
  ) => FlipByKeyResult;
}

/** Returns the elements of the card `cardId` on the page: one per lane that draws it. */
const findCardElements = (scroller: HTMLElement, cardId: string): readonly HTMLElement[] => [
  ...scroller.querySelectorAll<HTMLElement>(`[data-card-id="${CSS.escape(cardId)}"]`),
];

/**
 * Returns the place a card that is now only a line was sent to: the folded
 * lane's count, or the "N landed" line of its cell.
 */
const buildHidingPlace = (scroller: HTMLElement, laneId: string, stage: BoardStage): DropPlace =>
  scroller.querySelector(`[data-fold-row="${CSS.escape(laneId)}"]`) === null
    ? { kind: "cell", laneId, stage, beforeCardId: null }
    : { kind: "folded-lane", laneId, stage };

/**
 * Closes the dent once it has stood for `DENT_HOLD_MS` and the hand is out of
 * its lane: the cards below glide up on `self`. The hand is asked about only
 * after the hold, so a pointer that came back to the lane meanwhile keeps the
 * dent open. The wait does not stop at the eight seconds a change usually
 * waits, or the dent would close under a pointer that rests in the lane. It
 * stops at `DENT_LONGEST_WAIT_MS`, so a pointer parked in the lane does not
 * keep a hole open for good. Removes the dent at once when `signal` aborts.
 * Returns when the dent is gone.
 */
const closeDentWhenHandIsOut = async (
  scroller: HTMLElement,
  dent: HTMLElement,
  options: { isDragging: () => boolean; signal: AbortSignal },
): Promise<void> => {
  const lane = dent.closest(".board-lane");
  const isDone =
    (await pauseFor(DENT_HOLD_MS, options.signal)) &&
    (await waitForVisibleStillHand({
      targets: () => (lane === null ? [] : [lane]),
      isDragging: options.isDragging,
      signal: options.signal,
      longestWait: DENT_LONGEST_WAIT_MS,
    }));
  if (!isDone) {
    dent.remove();
    return;
  }
  if (dent.isConnected) flipBoard(scroller, "self", () => dent.remove());
};

/**
 * Keeps `cards`, which are crossing to their new cell, above the cards they
 * pass (`data-landing`), and the cause label on them, until `CROSSING_MS` have
 * passed or `signal` aborts. The cards are new elements: React makes one when
 * a card changes cell, so the label is moved from the old card to the new one.
 */
const holdArrivalLook = (
  cards: readonly HTMLElement[],
  labels: CauseLabels | undefined,
  signal: AbortSignal,
): void => {
  for (const card of cards) card.dataset["landing"] = "";
  labels?.moveTo(cards);
  const finish = (): void => {
    clearTimeout(timer);
    signal.removeEventListener("abort", finish);
    labels?.remove();
    for (const card of cards) delete card.dataset["landing"];
  };
  const timer = setTimeout(finish, CROSSING_MS);
  signal.addEventListener("abort", finish, { once: true });
};

/**
 * Draws the read with `commit` and plays the moves in it. It copies each
 * moving card in view before the page changes, so the copy can fly where the
 * card is no longer drawn; opens a dent in place of each card that leaves its
 * cell, inside the FLIP, right before the commit; and plays what follows the
 * commit. Under Reduce motion nothing flies and nothing glides: the card
 * appears in its new place with a fade, its cause label still shows, and the
 * dents still keep the old places open.
 */
const drawWithMoves = (
  scroller: HTMLElement,
  moves: readonly SelfMove[],
  spring: SpringName,
  commit: () => void,
  options: { isDragging: () => boolean; signal: AbortSignal },
): FlipByKeyResult => {
  const before = moves.flatMap((move) => findCardElements(scroller, move.cardId));
  const flights = launchFlights(scroller, before, 0);
  const dents: HTMLElement[] = [];
  const result = flipBoard(scroller, spring, () => {
    for (const card of before) {
      // A card in a stack leaves with the stack's shape to settle: it just goes.
      if (card.parentElement?.classList.contains("board-cell") === true) {
        dents.push(openDent(card));
      }
    }
    commit();
  });
  const isReduced = isMotionReduced();
  for (const move of moves) {
    const cards = findCardElements(scroller, move.cardId);
    const moveFlights = flights.filter((flight) => flight.cardId === move.cardId);
    const hidden = moveFlights.filter(
      (flight) =>
        findCardElement(scroller, { laneId: flight.laneId, cardId: move.cardId }) === null,
    );
    for (const flight of moveFlights) {
      if (!hidden.includes(flight)) removeFlight(flight.ghost);
    }
    flyFlightsTo(
      hidden,
      (flight) =>
        findHidingPlace(
          scroller,
          buildHidingPlace(scroller, flight.laneId, move.stage),
          move.stage,
        ),
      INTO_PLACE,
      "self",
    );
    if (cards.length === 0) {
      // The copy that flies carries its own label.
      move.labels?.remove();
      continue;
    }
    if (isReduced) fadeInCards(cards, "self");
    holdArrivalLook(cards, move.labels, options.signal);
  }
  for (const dent of dents) void closeDentWhenHandIsOut(scroller, dent, options);
  return result;
};

/**
 * Returns the parts of a card moving by itself (`SelfMoves`). `isCarrying`
 * says whether the user carries a card: a drag holds the announcement and the
 * closing of a dent. Everything it started and has not finished stops when the
 * screen goes.
 */
export const useSelfMoves = ({ isCarrying }: { readonly isCarrying: boolean }): SelfMoves => {
  const latest = useRef({ isCarrying });
  useEffect(() => {
    latest.current = { isCarrying };
  });
  // Made in a layout effect so that the first draw, which comes from a
  // microtask queued by a later layout effect, can use it.
  const lifetime = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
    };
  }, []);
  const announced = useRef(new Map<string, CauseLabels>());
  const released = useRef(new Set<string>());

  const announce = useCallback(
    async (change: HeldChange, { card, findTargets, signal }: HeldContext): Promise<boolean> => {
      const cause = change.kind === "move" ? card?.stageCause : undefined;
      if (cause === undefined) return true;
      const labels = showCauseLabel(
        findTargets().filter((each) => each instanceof HTMLElement),
        cause.text,
      );
      announced.current.set(change.cardId, labels);
      signal.addEventListener(
        "abort",
        () => {
          labels.remove();
          if (announced.current.get(change.cardId) === labels)
            announced.current.delete(change.cardId);
        },
        { once: true },
      );
      const isHeld = await pauseFor(
        isMotionReduced() ? CAUSE_HELD_REDUCED_MS : CAUSE_HELD_MS,
        signal,
      );
      // A hand may have taken a card during the hold: nothing moves in the hand.
      return (
        isHeld &&
        (await waitForVisibleStillHand({
          targets: () => [],
          isDragging: () => latest.current.isCarrying,
          signal,
        }))
      );
    },
    [],
  );

  const noteReleased = useCallback((change: HeldChange): void => {
    if (change.kind === "move") released.current.add(change.cardId);
  }, []);

  const draw = useCallback<SelfMoves["draw"]>((scroller, { shown, next }, spring, commit) => {
    const moves = listCardMoves(shown, next).flatMap((change): SelfMove[] => {
      if (change.kind !== "moved" || !released.current.has(change.cardId)) return [];
      const labels = announced.current.get(change.cardId);
      announced.current.delete(change.cardId);
      return [{ cardId: change.cardId, stage: change.to.stage, labels }];
    });
    released.current.clear();
    return drawWithMoves(scroller, moves, spring, commit, {
      isDragging: () => latest.current.isCarrying,
      signal: lifetime.current?.signal ?? new AbortController().signal,
    });
  }, []);

  return useMemo(() => ({ announce, noteReleased, draw }), [announce, noteReleased, draw]);
};
