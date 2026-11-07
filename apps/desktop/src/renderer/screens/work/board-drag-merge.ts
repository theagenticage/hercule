/**
 * The merge gesture of a carry: when the card in the hand rests over the
 * middle of another card (or Option is held), the two are drawn together. The
 * card in the hand docks on the corner of the card it would merge into, and
 * moving off the middle of that card undoes it.
 */
import type { WorkCard } from "@hercule/contract";
import { measureLayoutRect } from "../../app/motion";
import { CARRY_SCALE, type Carry } from "./board-drag-carry";
import { markMergeTarget, unmarkMergeTarget } from "./merge-target";

/** How long, in milliseconds, the hand must rest over the middle of a card before the two are drawn together. */
const MERGE_DWELL_MS = 1000;

/** How far, in pixels, the pointer may drift from where it began to rest before the wait starts again. */
const MERGE_STILL_DISTANCE = 6;

/** Where the card in the hand docks on the card it merges into: this far across and down from its corner, in pixels. */
const DOCK_ACROSS = 10;
const DOCK_DOWN = 8;

/** How the card in the hand looks when docked: smaller, tilted, and lifted less. */
const DOCK_SCALE = 0.96;
const DOCK_TILT = 1.6;
const DOCK_LIFT = 0.6;

/** How long, in milliseconds, a card that leaves its dock glides to the pointer instead of jumping to it. */
const UNDOCK_GLIDE_MS = 200;

/** The functions that run the merge gesture of the carry that is in the hand. */
export interface MergeGesture {
  /** Docks the card in the hand on the card it merges into. Does nothing when it merges into none. */
  readonly dockOnMerge: (c: Carry) => void;
  /** Draws the card in the hand into the card `cardId`, or undoes that when `cardId` is `null`. */
  readonly setMergeTarget: (c: Carry, cardId: string | null) => void;
  /** Decides from where the pointer rests whether the carry is drawn into the card `candidateId`, or `null`. */
  readonly followMergeWish: (c: Carry, candidateId: string | null) => void;
}

/**
 * Returns the merge gesture for the board in `scroller`. `readCards` returns
 * the cards the board draws now, and `isCarrying` tells whether `c` is still
 * the carry in the hand, which a timer checks before it draws the cards together.
 */
export const createMergeGesture = (
  scroller: HTMLElement,
  readCards: () => readonly WorkCard[],
  isCarrying: (c: Carry) => boolean,
): MergeGesture => {
  /** Docks the card in the hand on the corner of the card it merges into, smaller and tilted. */
  const dockOnMerge = (c: Carry): void => {
    if (c.merge === null) return;
    const place = measureLayoutRect(c.merge.element);
    c.body.to(
      {
        x: place.left + DOCK_ACROSS - c.home.left,
        y: place.top + DOCK_DOWN - c.home.top,
        s: DOCK_SCALE,
        r: DOCK_TILT,
        l: DOCK_LIFT,
      },
      "hand",
      { reduced: c.reduced },
    );
  };

  /**
   * Draws the card in the hand into the card `cardId` for a merge, or undoes
   * it all at once when `cardId` is `null`: the card in the hand comes back
   * to the pointer, the target settles, and the slot opens again.
   */
  const setMergeTarget = (c: Carry, cardId: string | null): void => {
    if (c.merge?.cardId === cardId) return;
    if (c.merge !== null) {
      unmarkMergeTarget(c.merge.element);
      c.merge = null;
      c.slot.classList.remove("is-shut");
      c.glideUntil = performance.now() + UNDOCK_GLIDE_MS;
      c.body.to(
        {
          x: c.hand.x - c.grab.x - c.home.left,
          y: c.hand.y - c.grab.y - c.home.top,
          s: CARRY_SCALE,
          l: 1,
        },
        "hand",
        { reduced: c.reduced },
      );
    }
    if (cardId === null) return;
    const element = scroller.querySelector<HTMLElement>(`[data-card-id="${cardId}"]`);
    const card = readCards().find((each) => each.id === cardId);
    if (element === null || card === undefined) return;
    c.merge = { cardId, element };
    c.slot.classList.add("is-shut");
    markMergeTarget(element, card.title);
    dockOnMerge(c);
  };

  /**
   * Decides from where the pointer rests whether the carry is drawn into the
   * card `candidateId` (the card whose middle it is over, or `null`). Only a
   * hand held still over a card's middle means merge, or Option at once:
   * passing over a card, or still deciding where to put the card, starts
   * nothing. The wait starts again when the pointer moves more than
   * `MERGE_STILL_DISTANCE` or reaches another card, and moving off the middle
   * of the target undoes the merge at once.
   */
  const followMergeWish = (c: Carry, candidateId: string | null): void => {
    const hasMoved = Math.hypot(c.hand.x - c.rest.x, c.hand.y - c.rest.y) > MERGE_STILL_DISTANCE;
    const isSameWish = candidateId === c.hoverCardId && !hasMoved;
    if (!isSameWish) {
      c.hoverCardId = candidateId;
      c.rest = { x: c.hand.x, y: c.hand.y };
      window.clearTimeout(c.dwellTimer);
    }
    if (candidateId === null) {
      setMergeTarget(c, null);
    } else if (c.merge?.cardId === candidateId) {
      // Drifting inside the middle of the target keeps it.
    } else if (c.isAltHeld) {
      setMergeTarget(c, candidateId);
    } else if (!isSameWish) {
      setMergeTarget(c, null);
      c.dwellTimer = window.setTimeout(() => {
        if (isCarrying(c) && c.hoverCardId === candidateId) setMergeTarget(c, candidateId);
      }, MERGE_DWELL_MS);
    }
  };

  return { dockOnMerge, setMergeTarget, followMergeWish };
};
