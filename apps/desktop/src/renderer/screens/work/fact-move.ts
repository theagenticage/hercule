/**
 * A card moving by itself, as the board draws it once the cause has landed:
 * the card crosses to the end of its new cell on `self`, the place it left
 * stays open as a dent, and a card that is now only a line ("3 landed", a
 * folded lane's count) fades on the way into that line. Everything here moves
 * `transform` and `opacity` only, through the motion kernel.
 */
import type { BoardStage } from "@hercule/contract";
import type { DropPlace } from "@hercule/client-core/work";
import { isMotionReduced, pauseFor, waitForVisibleStillHand } from "../../app/motion";
import { openDent, showCauseLabel } from "../desk";
import {
  fadeInCards,
  INTO_PLACE,
  launchFlights,
  removeFlight,
  flyFlightsTo,
} from "./board-flights";
import { findCardElement } from "./card-in-lane";
import { flipBoard } from "./flip-board";
import { findHidingPlace } from "./land-card";

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

/** A card that moves by itself in one change of the board. */
export interface SelfMovingCard {
  readonly cardId: string;
  /** The stage the card moves to. */
  readonly stage: BoardStage;
  /** The words of why it moves ("Pull request #6221 merged"), or `undefined` when nothing says why. */
  readonly cause: string | undefined;
}

/** The parts of the change that a caller plays around its own commit of the page. */
export interface SelfMoves {
  /** Opens a dent in place of each card that leaves its cell. Call it inside the change, right before the page is committed. */
  readonly keepPlaces: () => void;
  /**
   * Plays what follows the commit: the cards cross (the glide itself is the
   * board's FLIP), each card wears its cause label until it has arrived, a
   * card that has no place on the page flies into the line that stands for
   * it, and the dents close once the hand is out of their lane. `isDragging`
   * says whether the user carries a card, and `signal` stops everything: the
   * dents go at once.
   */
  readonly play: (options: { isDragging: () => boolean; signal: AbortSignal }) => void;
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
 * pass (`data-landing`), and keeps the cause label `cause` on them, until
 * `CROSSING_MS` have passed or `signal` aborts. The cards are new elements:
 * React made them when the card changed cell, so the label from the old card
 * is put on them again, with no rise.
 */
const holdArrivalLook = (
  cards: readonly HTMLElement[],
  cause: string | undefined,
  signal: AbortSignal,
): void => {
  for (const card of cards) card.dataset["landing"] = "";
  const removeLabel = cause === undefined ? undefined : showCauseLabel(cards, cause, false);
  const finish = (): void => {
    clearTimeout(timer);
    signal.removeEventListener("abort", finish);
    removeLabel?.();
    for (const card of cards) delete card.dataset["landing"];
  };
  const timer = setTimeout(finish, CROSSING_MS);
  signal.addEventListener("abort", finish, { once: true });
};

/**
 * Gets the page ready for `moves`, the cards that move by themselves in the
 * change the caller is about to commit. Call it before the change, while the
 * cards are still where they were: it copies each card in view, so the copy
 * can fly where the card is no longer drawn. Then call `keepPlaces` inside the
 * change and `play` after it.
 *
 * Under Reduce motion nothing flies and nothing glides: the card appears in
 * its new place with a fade, its cause label still shows, and the dents still
 * keep the old places open.
 */
export const prepareSelfMoves = (
  scroller: HTMLElement,
  moves: readonly SelfMovingCard[],
): SelfMoves => {
  const before = moves.flatMap((move) => findCardElements(scroller, move.cardId));
  const flights = launchFlights(scroller, before, 0);
  const dents: HTMLElement[] = [];
  return {
    keepPlaces: () => {
      for (const card of before) {
        // A card in a stack leaves with the stack's shape to settle: it just goes.
        if (card.parentElement?.classList.contains("board-cell") === true) {
          dents.push(openDent(card));
        }
      }
    },
    play: (options) => {
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
        if (cards.length === 0) continue;
        if (isReduced) fadeInCards(cards, "self");
        holdArrivalLook(cards, move.cause, options.signal);
      }
      for (const dent of dents) void closeDentWhenHandIsOut(scroller, dent, options);
    },
  };
};
