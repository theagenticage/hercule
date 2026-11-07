/**
 * Moving things whose place in the layout just changed: FLIP (measure where
 * elements are, change the page, then move each from where it was to where it
 * is now), the layout rectangle, and the ghost that outlives its element.
 *
 * Each function reads the page once, before it writes, so a long list costs
 * one layout and not one per element.
 */
import { findBody, MOVING_CLASS, RISING_CLASS, trackBody } from "./body";
import { isMotionReduced } from "./reduced";
import type { SpringName } from "./springs";

/** The longest a stagger may delay an element, in milliseconds. A long list never takes longer because it is long. */
export const LONGEST_STAGGER = 130;

/** A move further than this many pixels is a jump in place: it is more than a screen, and nobody could follow the journey. */
const LONGEST_JOURNEY = 1400;

/** A move shorter than this many pixels is not drawn. */
const SMALLEST_MOVE = 0.5;

/** Returns the delay for the element at `index` when elements start `gap` milliseconds apart, never more than `LONGEST_STAGGER`. */
export const staggerDelay = (index: number, gap: number): number =>
  Math.min(index * gap, LONGEST_STAGGER);

/** How `flipElements` moves the elements. */
export interface FlipOptions {
  /** The spring they move on. Defaults to `hand`. */
  readonly spring?: SpringName;
  /** Returns the milliseconds to delay the element at `index`, counted in the list given to `flipElements`. The delay is cut to `LONGEST_STAGGER`. */
  readonly stagger?: (element: HTMLElement, index: number) => number;
}

/** The place and size of an element as the layout has it, with no animation offset. */
export interface LayoutRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Returns where `element` sits in window coordinates with its body's offset
 * and scale taken away: the place the layout gave it. Ignores tilt.
 */
export const measureLayoutRect = (element: HTMLElement): LayoutRect => {
  const rect = element.getBoundingClientRect();
  const values = findBody(element)?.values;
  if (values === undefined || (values.x === 0 && values.y === 0 && values.s === 1)) {
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }
  const width = rect.width / values.s;
  const height = rect.height / values.s;
  return {
    left: rect.left - values.x - (width - rect.width) / 2,
    top: rect.top - values.y - (height - rect.height) / 2,
    width,
    height,
  };
};

/**
 * Runs `mutate`, then moves every element in `elements` from where it was on
 * screen to where `mutate` put it. "Where it was" is what the user saw,
 * including a move still under way, so changing the page again halfway turns
 * the elements around with the speed they have. An element `mutate` removed
 * is left alone. Under Reduce motion, and for a move of more than a screen,
 * the elements go straight to their places.
 */
export const flipElements = (
  elements: readonly HTMLElement[],
  mutate: () => void,
  options: FlipOptions = {},
): void => {
  const before = elements.map((element) => element.getBoundingClientRect());
  mutate();
  const reduced = isMotionReduced();
  const after = elements.map((element) =>
    element.isConnected ? measureLayoutRect(element) : null,
  );
  const spring = options.spring ?? "hand";
  elements.forEach((element, index) => {
    const from = before[index];
    const to = after[index];
    if (from === undefined || to === undefined || to === null) return;
    const body = trackBody(element);
    const dx = from.left - to.left;
    const dy = from.top - to.top;
    const isMoved = Math.abs(dx) >= SMALLEST_MOVE || Math.abs(dy) >= SMALLEST_MOVE;
    const hasOffset = body.values.x !== 0 || body.values.y !== 0;
    if (!isMoved && !hasOffset) return;
    if (reduced || Math.abs(dy) > LONGEST_JOURNEY) {
      body.set({ x: 0, y: 0 });
      return;
    }
    body.relocate(dx, dy);
    if (dy > 0) element.classList.add(RISING_CLASS);
    const delay = Math.min(options.stagger?.(element, index) ?? 0, LONGEST_STAGGER);
    body.to({ x: 0, y: 0 }, spring, { delay, reduced });
  });
};

/**
 * Appends to `layer` a copy of `element` that looks exactly as it does now,
 * and returns it, so the copy can keep moving after the original has left the
 * page. The copy has no `id` or `tabindex`, and has the class `is-ghost`. The
 * caller moves the copy with `trackBody` and removes it. `layer` must be
 * positioned, with its top left at the origin of the coordinates it is given.
 */
export const ghostElement = (element: HTMLElement, layer: HTMLElement): HTMLElement => {
  const rect = measureLayoutRect(element);
  const host = layer.getBoundingClientRect();
  const copy = element.cloneNode(true) as HTMLElement;
  copy.removeAttribute("id");
  copy.removeAttribute("tabindex");
  copy.classList.add("is-ghost");
  copy.classList.remove(MOVING_CLASS, RISING_CLASS);
  Object.assign(copy.style, {
    position: "absolute",
    margin: "0",
    left: `${rect.left - host.left}px`,
    top: `${rect.top - host.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    transform: "",
    opacity: "",
  });
  layer.appendChild(copy);
  const shown = findBody(element)?.values;
  if (shown !== undefined) trackBody(copy).set(shown);
  return copy;
};
