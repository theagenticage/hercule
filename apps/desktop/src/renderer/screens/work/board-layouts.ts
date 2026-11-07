/**
 * Where the parts of the Work board stood after the last change, and the glide
 * that carries them to where a read put them. A read changes the page without
 * the screen being told first, so there is no moment to measure "before"
 * (`flipByKey` needs one). The screen measures after every change instead,
 * and the next read starts from that.
 */
import {
  findBody,
  isMotionReduced,
  measureLayoutRect,
  RISING_CLASS,
  trackBody,
  type SpringName,
} from "../../app/motion";

/** What moves when the board changes: cards, lane heads, the counts of folded lanes and the "13 more" lines. */
export const MOVABLE_SELECTOR =
  "[data-card-id], [data-lane-head], [data-fold-row], [data-more-cell-id]";

/** Returns the key that tells the same part apart across a change, or `null` for an element that is not one. */
export const readMotionKey = (element: HTMLElement): string | null => {
  // The card in the hand is the drag's, and nothing else moves it.
  if (element.hasAttribute("data-dragged")) return null;
  const { cardId, laneHead, foldRow, moreCellId } = element.dataset;
  if (cardId !== undefined) return `card:${cardId}`;
  if (laneHead !== undefined) return `head:${laneHead}`;
  if (foldRow !== undefined) return `fold:${foldRow}`;
  if (moreCellId !== undefined) return `more:${moreCellId}`;
  return null;
};

/** A move longer than this many pixels is a jump in place: nobody could follow a journey of more than a screen. */
const LONGEST_JOURNEY = 1400;

/** A move shorter than this many pixels is not drawn. */
const SMALLEST_MOVE = 0.5;

/** One part of the board: its element, and where the layout put it in the board's own coordinates. */
interface PartPlace {
  readonly element: HTMLElement;
  readonly left: number;
  readonly top: number;
}

/** Where every part of the board stood at one time. */
export interface BoardLayouts {
  /** The width of the board then. A different width means the window changed under the layout, and these places are no longer true. */
  readonly width: number;
  readonly parts: ReadonlyMap<string, PartPlace>;
}

/**
 * Returns where the layout put every movable part under `scroller`, with the
 * scroll position taken away, so a scroll between two measurements does not
 * look like a move.
 */
export const measureBoardLayouts = (scroller: HTMLElement): BoardLayouts => {
  const origin = scroller.getBoundingClientRect();
  const parts = new Map<string, PartPlace>();
  for (const element of scroller.querySelectorAll<HTMLElement>(MOVABLE_SELECTOR)) {
    const key = readMotionKey(element);
    if (key === null || parts.has(key)) continue;
    const rect = measureLayoutRect(element);
    parts.set(key, {
      element,
      left: rect.left - origin.left + scroller.scrollLeft,
      top: rect.top - origin.top + scroller.scrollTop,
    });
  }
  return { width: scroller.clientWidth, parts };
};

/**
 * Moves every part of the board from where it looked in `before` to where the
 * layout has it now, on `spring`, and returns the cards that were not in
 * `before`. A part that was still gliding starts from where it looked, with
 * its speed. Does nothing when the board has another width than `before`, and
 * under Reduce motion the parts go straight to their places.
 */
export const glideFromLayouts = (
  scroller: HTMLElement,
  before: BoardLayouts,
  spring: SpringName,
): readonly HTMLElement[] => {
  const born: HTMLElement[] = [];
  const isSameWidth = before.width === scroller.clientWidth;
  const origin = scroller.getBoundingClientRect();
  const reduced = isMotionReduced();
  for (const element of scroller.querySelectorAll<HTMLElement>(MOVABLE_SELECTOR)) {
    const key = readMotionKey(element);
    if (key === null) continue;
    const start = before.parts.get(key);
    if (start === undefined) {
      if (key.startsWith("card:")) born.push(element);
      continue;
    }
    if (!isSameWidth) continue;
    const now = measureLayoutRect(element);
    const left = now.left - origin.left + scroller.scrollLeft;
    const top = now.top - origin.top + scroller.scrollTop;
    if (start.element !== element && !start.element.isConnected) findBody(start.element)?.clear();
    // A part the layout did not move keeps the motion it has: a card landing
    // from a drop must not be handed to a slower spring by a read.
    if (Math.abs(start.left - left) < SMALLEST_MOVE && Math.abs(start.top - top) < SMALLEST_MOVE) {
      continue;
    }
    const offset = findBody(start.element)?.values;
    const dx = start.left + (offset?.x ?? 0) - left;
    const dy = start.top + (offset?.y ?? 0) - top;
    const body = trackBody(element);
    if (reduced || Math.abs(dy) > LONGEST_JOURNEY) {
      body.set({ x: 0, y: 0 });
      continue;
    }
    body.relocate(
      dx,
      dy,
      start.element === element ? undefined : findBody(start.element)?.velocity,
    );
    if (dy > 0) element.classList.add(RISING_CLASS);
    body.to({ x: 0, y: 0 }, spring, { reduced });
  }
  return born;
};
