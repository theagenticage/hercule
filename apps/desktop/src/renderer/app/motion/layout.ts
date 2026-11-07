/**
 * Moving things whose place in the layout just changed: FLIP (measure where
 * elements are, change the page, then move each from where it was to where it
 * is now), the layout rectangle, and the ghost that outlives its element.
 *
 * Each function reads the page once, before it writes, so a long list costs
 * one layout and not one per element.
 */
import { findBody, MOVING_CLASS, RISING_CLASS, trackBody, type Velocity } from "./body";
import { isMotionReduced } from "./reduced";
import type { SpringName } from "./springs";

/** The longest a stagger may delay an element, in milliseconds. A long list never takes longer because it is long. */
const LONGEST_STAGGER = 130;

/** A move further than this many pixels is a jump in place: it is more than a screen, and nobody could follow the journey. */
const LONGEST_JOURNEY = 1400;

/** A move shorter than this many pixels is not drawn. */
const SMALLEST_MOVE = 0.5;

/** Returns the delay for the element at `index` when elements start `gap` milliseconds apart, never more than `LONGEST_STAGGER`. */
export const staggerDelay = (index: number, gap: number): number =>
  Math.min(index * gap, LONGEST_STAGGER);

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

/** Returns the center of a rectangle, in the same coordinates. */
export const computeCenter = (rect: LayoutRect): { readonly x: number; readonly y: number } => ({
  x: rect.left + rect.width / 2,
  y: rect.top + rect.height / 2,
});

/** Where an element looked before the page changed, and the speed it moved at. */
interface FlipStart {
  readonly rect: DOMRect;
  readonly velocity?: Velocity | undefined;
}

/**
 * Moves `element` from `start` to `to`, the place the layout now gives it. A
 * move shorter than half a pixel is not drawn, unless the element still
 * carries an offset from an earlier move. Under Reduce motion, and for a move
 * of more than a screen, the element goes straight to its place.
 */
const springFrom = (
  element: HTMLElement,
  start: FlipStart,
  to: LayoutRect,
  spring: SpringName,
  delay: number,
  reduced: boolean,
): void => {
  const body = trackBody(element);
  const dx = start.rect.left - to.left;
  const dy = start.rect.top - to.top;
  const isMoved = Math.abs(dx) >= SMALLEST_MOVE || Math.abs(dy) >= SMALLEST_MOVE;
  const hasOffset = body.values.x !== 0 || body.values.y !== 0;
  if (!isMoved && !hasOffset) return;
  if (reduced || Math.abs(dy) > LONGEST_JOURNEY) {
    body.set({ x: 0, y: 0 });
    return;
  }
  body.relocate(dx, dy, start.velocity);
  if (dy > 0) element.classList.add(RISING_CLASS);
  body.to({ x: 0, y: 0 }, spring, { delay: Math.min(delay, LONGEST_STAGGER), reduced });
};

/** How `flipByKey` finds and moves the elements. */
export interface FlipByKeyOptions {
  /** The element that holds every element to move, before and after `mutate`. It must stay on the page. */
  readonly root: ParentNode;
  /** The CSS selector of the elements to move. */
  readonly selector: string;
  /** Returns the key that tells the same thing apart across a change, or `null` for an element to leave alone. */
  readonly readKey: (element: HTMLElement) => string | null;
  /** Changes the page. It must commit the change before it returns: the new places are measured right after. */
  readonly mutate: () => void;
  /** The spring they move on. Defaults to `hand`. */
  readonly spring?: SpringName;
  /** Returns the milliseconds to delay the element at `index` of the elements found after `mutate`. The delay is cut to `LONGEST_STAGGER`. */
  readonly stagger?: (element: HTMLElement, index: number) => number;
}

/** Collects the elements under `root` that match `selector`, by key. The first element of a key wins. */
const collectByKey = (
  root: ParentNode,
  selector: string,
  readKey: (element: HTMLElement) => string | null,
): Map<string, HTMLElement> => {
  const found = new Map<string, HTMLElement>();
  for (const element of root.querySelectorAll<HTMLElement>(selector)) {
    const key = readKey(element);
    if (key !== null && !found.has(key)) found.set(key, element);
  }
  return found;
};

/** What `flipByKey` found after `mutate`. */
export interface FlipByKeyResult {
  /** Where the layout put each element, by key, in window pixels, with no animation offset. */
  readonly places: ReadonlyMap<string, LayoutRect>;
  /** The elements whose key was not on the page before `mutate`: the things that are new. */
  readonly born: readonly HTMLElement[];
}

/**
 * Runs `mutate`, then moves every element from where it was on screen to
 * where `mutate` put it. It is made for a page where React may replace an
 * element with a new one for the same thing, such as a card that moves to
 * another column. "Where it was" is what the user saw, including a move still
 * under way, so changing the page again halfway turns the elements around with
 * the speed they have. Under Reduce motion, and for a move of more than a
 * screen, the elements go straight to their places. Measures every element under `root` that matches `selector`, by key, runs
 * `mutate`, finds the elements again by key, and moves each from where it
 * looked to where it is now.
 *
 * - An element that was mid-flight starts from what is on screen. When the
 *   element is a new one, it takes over the old element's speed too, and the
 *   old element's body is stopped.
 * - A key found only before `mutate` (the thing left) is left alone. One found
 *   only after (it is new) is left alone too, and is returned in `born`.
 * - Reads the page once before `mutate` and once after, then writes. The
 *   places measured after are returned, so a caller that needs them does not
 *   measure again.
 */
export const flipByKey = (options: FlipByKeyOptions): FlipByKeyResult => {
  const { root, selector, readKey, mutate } = options;
  const before = new Map<string, FlipStart & { readonly element: HTMLElement }>();
  for (const [key, element] of collectByKey(root, selector, readKey)) {
    before.set(key, {
      element,
      rect: element.getBoundingClientRect(),
      velocity: findBody(element)?.velocity,
    });
  }
  mutate();
  const reduced = isMotionReduced();
  const spring = options.spring ?? "hand";
  const places = new Map<string, LayoutRect>();
  const born: HTMLElement[] = [];
  const after: {
    readonly element: HTMLElement;
    readonly index: number;
    readonly start: FlipStart & { readonly element: HTMLElement };
    readonly to: LayoutRect;
  }[] = [];
  [...collectByKey(root, selector, readKey)].forEach(([key, element], index) => {
    const to = measureLayoutRect(element);
    places.set(key, to);
    const start = before.get(key);
    if (start === undefined) born.push(element);
    else after.push({ element, index, start, to });
  });
  for (const { element, index, start, to } of after) {
    const isReplaced = start.element !== element;
    // An old element that left the page must stop moving: its body keeps the clock awake.
    if (isReplaced && !start.element.isConnected) findBody(start.element)?.clear();
    springFrom(
      element,
      isReplaced ? start : { rect: start.rect },
      to,
      spring,
      options.stagger?.(element, index) ?? 0,
      reduced,
    );
  }
  return { places, born };
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
