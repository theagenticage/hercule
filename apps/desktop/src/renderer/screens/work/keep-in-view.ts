/** Extra room between a card and the edge of what is in view, in pixels. */
const EDGE_MARGIN = 10;

/**
 * The room at the foot of the board that the undo line can cover. A card kept
 * clear of it is not hidden by the line that a move brings up.
 */
const FOOT_CLEARANCE = 72;

/** Where one end of a card and the visible area stand on one axis, in window coordinates. */
interface AxisPlace {
  readonly cardStart: number;
  readonly cardEnd: number;
  readonly viewStart: number;
  readonly viewEnd: number;
  /** How far the start of the view is covered, such as by sticky headers. */
  readonly startCovered: number;
  readonly endCovered: number;
  /** The scroll position now. */
  readonly scroll: number;
}

/**
 * Returns the scroll position that brings the card into the uncovered part of
 * the view by the least movement. A card already inside it keeps the scroll
 * position as it is. A card taller than the uncovered part is lined up with
 * its start, so that its first lines show.
 */
export const computeScrollToReveal = (place: AxisPlace): number => {
  const visibleStart = place.viewStart + place.startCovered;
  const visibleEnd = place.viewEnd - place.endCovered;
  if (place.cardStart < visibleStart) return place.scroll - (visibleStart - place.cardStart);
  if (place.cardEnd > visibleEnd) {
    return place.scroll + Math.min(place.cardEnd - visibleEnd, place.cardStart - visibleStart);
  }
  return place.scroll;
};

/**
 * Scrolls `scroller` by the least amount that brings `card` fully into view.
 * The stage headers stick to the top of the board, and in Bands the head of
 * the card's lane sticks under them, so the top of the view is counted from
 * below them. Does nothing when the card is in view already.
 */
export const keepCardInView = (scroller: HTMLElement, card: HTMLElement): void => {
  const view = scroller.getBoundingClientRect();
  const box = card.getBoundingClientRect();
  const rule = scroller.querySelector(".board-rule-wrap")?.getBoundingClientRect();
  const isBands = scroller.closest(".work-desk")?.getAttribute("data-lanes") === "band";
  const laneHead = isBands ? card.closest(".board-lane")?.querySelector(".board-lane-head") : null;
  const stuckHeadHeight = laneHead?.getBoundingClientRect().height ?? 0;
  scroller.scrollTop = computeScrollToReveal({
    cardStart: box.top,
    cardEnd: box.bottom,
    viewStart: view.top,
    viewEnd: view.bottom,
    startCovered: (rule === undefined ? 0 : rule.bottom - view.top) + stuckHeadHeight + EDGE_MARGIN,
    endCovered: FOOT_CLEARANCE,
    scroll: scroller.scrollTop,
  });
  scroller.scrollLeft = computeScrollToReveal({
    cardStart: box.left,
    cardEnd: box.right,
    viewStart: view.left,
    viewEnd: view.right,
    startCovered: EDGE_MARGIN,
    endCovered: EDGE_MARGIN,
    scroll: scroller.scrollLeft,
  });
};
