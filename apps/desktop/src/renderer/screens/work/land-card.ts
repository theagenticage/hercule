import type { CardMove, DropPlace } from "@hercule/client-core/work";
import { BOARD_STAGES, type BoardStage, type WorkCard } from "@hercule/contract";
import {
  computeCenter,
  measureLayoutRect,
  trackBody,
  type MotionBody,
  type SpringName,
  type Velocity,
} from "../../app/motion";
import { buildCellId } from "./use-work-view";

/** How long the thin ring on a card that landed in Landed stays on it, in milliseconds. A little longer than the ring's fade. */
const LANDED_RING_MS = 600;

/** How long the roll of a stage's changed count stays marked, in milliseconds. A little longer than the roll. */
const COUNT_ROLL_MS = 260;

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
  /** The body of the copy in the hand. */
  readonly body: MotionBody;
  /** The layer that holds the copy. */
  readonly layer: HTMLElement;
  /** Where the card was dropped, or `null` when it was sent home. */
  readonly place: DropPlace | null;
}

/** Returns the text of each stage's count, by stage: an empty text for a stage that shows none. */
export const readStageCounts = (scroller: HTMLElement): ReadonlyMap<BoardStage, string> =>
  new Map(
    BOARD_STAGES.map((stage) => [
      stage,
      scroller.querySelector(`.board-rule [data-stage="${stage}"] .desk-heading-count`)
        ?.textContent ?? "",
    ]),
  );

/** Rolls the number of each stage whose count changed since `before`, so the new count rises into place. */
export const rollChangedCounts = (
  scroller: HTMLElement,
  before: ReadonlyMap<BoardStage, string>,
): void => {
  for (const stage of BOARD_STAGES) {
    const count = scroller.querySelector<HTMLElement>(
      `.board-rule [data-stage="${stage}"] .desk-heading-count`,
    );
    if (count === null || count.textContent === before.get(stage)) continue;
    count.dataset["rolling"] = "";
    window.setTimeout(() => {
      delete count.dataset["rolling"];
    }, COUNT_ROLL_MS);
  }
};

/**
 * Returns the element that stands for a card dropped at the carry's place,
 * now that the card itself is not drawn: the "13 more" line of its cell, the
 * count of its stage on a folded lane, or that lane's head. Returns `null`
 * when the carry has no place.
 */
const findHidingPlace = (scroller: HTMLElement, carry: EndedCarry): Element | null => {
  const { place } = carry;
  if (place === null) return null;
  if (place.kind === "cell") {
    return scroller.querySelector(
      `[data-more-cell-id="${buildCellId(place.laneId, place.stage)}"]`,
    );
  }
  const foldRow = scroller.querySelector(`[data-fold-row="${place.laneId}"]`);
  const stage = place.stage ?? carry.card.stage;
  return (
    [...(foldRow?.children ?? [])].find(
      (cell) => cell instanceof HTMLElement && cell.dataset["stage"] === stage,
    ) ?? scroller.querySelector(`[data-lane-head="${place.laneId}"]`)
  );
};

/**
 * Sends the copy in the hand to the line that now stands for the card, and
 * fades it there: the count of the folded lane it was dropped on, or the
 * "3 landed" line of a cell that hides it. A card with no such place fades
 * where it is.
 */
const flyAway = (scroller: HTMLElement, carry: EndedCarry, pose: ReleasePose): void => {
  const target = findHidingPlace(scroller, carry);
  const remove = (): void => {
    carry.body.clear();
    carry.layer.remove();
  };
  if (target === null) {
    carry.body.to({ s: 0.96, o: 0 }, "travel", { done: remove });
    return;
  }
  const goal = computeCenter(target.getBoundingClientRect());
  carry.body.to(
    {
      x: goal.x - (pose.centerX - carry.body.values.x),
      y: goal.y - (pose.centerY - carry.body.values.y),
      s: 0.1,
      o: 0,
    },
    "travel",
    { done: remove },
  );
};

/**
 * Brings the card in the page down from the copy's pose, and removes the copy
 * in the same frame so nothing shows twice. The card may be a new element,
 * because a card that changed cell is a new one to React, so it is found by
 * its id. When it is not on the page (it went into a folded lane, or left the
 * board) the copy flies to where it went, or fades. `move` is the move the
 * drop sent, if any.
 */
export const landCard = (
  scroller: HTMLElement,
  carry: EndedCarry,
  pose: ReleasePose,
  spring: SpringName,
  move: CardMove | undefined,
): void => {
  const card = scroller.querySelector<HTMLElement>(`[data-card-id="${carry.card.id}"]`);
  if (card === null) {
    flyAway(scroller, carry, pose);
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
    done: () => {
      delete card.dataset["landing"];
      // Gives the card back to its stylesheet: no inline style stays on it.
      body.clear();
    },
  });
  carry.body.clear();
  carry.layer.remove();
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
