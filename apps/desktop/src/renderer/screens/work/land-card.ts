import { buildCellId, type CardMove, type DropPlace } from "@hercule/client-core/work";
import type { BoardStage, WorkCard } from "@hercule/contract";
import {
  measureLayoutRect,
  trackBody,
  type MotionBody,
  type SpringName,
  type Velocity,
} from "../../app/motion";
import { flyFlightsTo, INTO_PLACE, removeFlight } from "./board-flights";
import { findCardElement } from "./card-in-lane";

/** How long the thin ring on a card that landed in Landed stays on it, in milliseconds. A little longer than the ring's fade. */
const LANDED_RING_MS = 600;

/** How the card in the hand looked at the moment it was let go, which the landing starts from. */
export interface ReleasePose {
  readonly centerX: number;
  readonly centerY: number;
  readonly scale: number;
  readonly tilt: number;
  readonly lift: number;
  readonly velocity: Velocity;
}

/** The parts of a carry that has just ended which the landing needs. */
export interface EndedCarry {
  /** The card as it was when it was lifted. */
  readonly card: WorkCard;
  /** The id of the lane the card was lifted from. A Task under two outside places has a card in each lane. */
  readonly laneId: string;
  /** The copy in the hand. It is the only child of `layer`. */
  readonly ghost: HTMLElement;
  /** The body of the copy in the hand. */
  readonly body: MotionBody;
  /** The layer that holds the copy. */
  readonly layer: HTMLElement;
  /** Where the card was dropped, or `null` when it was sent home. */
  readonly place: DropPlace | null;
}

/**
 * Returns the element that stands for a card that has no place of its own on
 * the page at `place`: the "13 more" line of its cell, the count of its stage
 * on a folded lane, or that lane's head. A drop that keeps the card's stage
 * (`place.stage` is `null`) means `cardStage`. Returns `null` when there is
 * no place.
 */
export const findHidingPlace = (
  scroller: HTMLElement,
  place: DropPlace | null,
  cardStage: BoardStage,
): Element | null => {
  if (place === null) return null;
  if (place.kind === "cell") {
    return scroller.querySelector(
      `[data-more-cell-id="${CSS.escape(buildCellId(place.laneId, place.stage))}"]`,
    );
  }
  const foldRow = scroller.querySelector(`[data-fold-row="${CSS.escape(place.laneId)}"]`);
  const stage = place.stage ?? cardStage;
  return (
    [...(foldRow?.children ?? [])].find(
      (cell) => cell instanceof HTMLElement && cell.dataset["stage"] === stage,
    ) ?? scroller.querySelector(`[data-lane-head="${CSS.escape(place.laneId)}"]`)
  );
};

/**
 * Returns the element of the card the carry ended with: the card in the lane
 * it was dropped on, else the one in the lane it was lifted from (a drop on a
 * lane of an outside place changes only the stage, so the card stays in the
 * lane it was in), else any card of that Task. Returns `null` when the card
 * is not on the page, for example because it went into a folded lane, which
 * draws no cards.
 */
const findLandedCard = (scroller: HTMLElement, carry: EndedCarry): HTMLElement | null => {
  const { place } = carry;
  const laneIds = place === null ? [carry.laneId] : [place.laneId, carry.laneId];
  for (const laneId of laneIds) {
    const card = findCardElement(scroller, { laneId, cardId: carry.card.id });
    if (card !== null) return card;
  }
  return scroller.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(carry.card.id)}"]`);
};

/**
 * Sends `ghost`, the copy of a card, to the line that now stands for the
 * card, and fades it there: the count of the folded lane it went into, or the
 * "3 landed" line of a cell that hides it (`findHidingPlace`). A card with no
 * such place fades where it is. Both go on `travel`, because the user dropped
 * the card.
 */
const flyAway = (
  scroller: HTMLElement,
  ghost: HTMLElement,
  place: DropPlace | null,
  cardStage: BoardStage,
): void => {
  const target = findHidingPlace(scroller, place, cardStage);
  if (target === null) {
    trackBody(ghost).to({ s: 0.96, o: 0 }, "travel", {
      done: () => {
        removeFlight(ghost);
      },
    });
    return;
  }
  flyFlightsTo([{ ghost, delay: 0 }], () => target, INTO_PLACE);
};

/**
 * Brings the card in the page down from the copy's pose, and removes the copy
 * in the same frame so nothing shows twice. The card may be a new element,
 * because a card that changed cell is a new one to React, so it is found by
 * its id. When it is not on the page (it went into a folded lane, or left the
 * board) the copy flies to where it went, or fades. `move` is the move the
 * drop sent, if any. The card starts to come down `delay` milliseconds
 * after the copy leaves, standing where the copy stood meanwhile.
 */
export const landCard = (
  scroller: HTMLElement,
  carry: EndedCarry,
  pose: ReleasePose,
  spring: SpringName,
  move: CardMove | undefined,
  delay: number,
): void => {
  const card = findLandedCard(scroller, carry);
  if (card === null) {
    flyAway(scroller, carry.ghost, carry.place, carry.card.stage);
    return;
  }
  const place = measureLayoutRect(card);
  const body = trackBody(card);
  body.set({ s: pose.scale, r: pose.tilt, l: pose.lift });
  body.relocate(
    pose.centerX - (place.left + place.width / 2),
    pose.centerY - (place.top + place.height / 2),
    pose.velocity,
  );
  card.dataset["landing"] = "";
  body.to({ x: 0, y: 0, s: 1, r: 0, l: 0 }, spring, {
    delay,
    done: () => {
      delete card.dataset["landing"];
      // Gives the card back to its stylesheet: no inline style stays on it.
      body.clear();
    },
  });
  removeFlight(carry.ghost);
  // Hiding the card dropped its focus; the keyboard goes on from where the card now is.
  if (document.activeElement === null || document.activeElement === document.body) {
    card.focus({ preventScroll: true });
  }
  if (move?.stage === "landed" && carry.card.stage !== "landed") {
    card.dataset["justLanded"] = "";
    window.setTimeout(() => {
      delete card.dataset["justLanded"];
    }, LANDED_RING_MS);
  }
};
