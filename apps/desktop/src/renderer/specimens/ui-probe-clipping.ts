/**
 * The geometry of the UI probe's clipping (ui-probe.ts): rectangles, and how
 * much of a piece of text the ancestors that cut or scroll leave out of
 * reach. Plain maths on rectangles in CSS pixels, measured from the top left
 * of the window; the probe reads the boxes and overflow from the page and
 * passes them in.
 */
import type { ProbeRect } from "./ui-probe-types";

/** Returns the area of a rectangle in square pixels. */
export function computeArea(rect: ProbeRect): number {
  return Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
}

/** Returns the part both rectangles cover, or null when they share no area. */
export function intersectRects(first: ProbeRect, second: ProbeRect): ProbeRect | null {
  const left = Math.max(first.left, second.left);
  const top = Math.max(first.top, second.top);
  const right = Math.min(first.right, second.right);
  const bottom = Math.min(first.bottom, second.bottom);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

/** How an element treats the content that overflows it, along each axis. */
export interface OverflowAxes {
  /** Whether the element cuts its content for good along the axis: overflow `hidden` or `clip`. */
  readonly cutsX: boolean;
  readonly cutsY: boolean;
  /** Whether the user can scroll to the content along the axis: overflow `auto` or `scroll`. */
  readonly scrollsX: boolean;
  readonly scrollsY: boolean;
}

/** An ancestor that cuts or scrolls its content, with the area it clips the content to. */
export interface ClippingAncestor {
  readonly facts: OverflowAxes;
  readonly clip: ProbeRect;
}

/**
 * Returns how far to move the span [low, high] so that it lies inside
 * [clipLow, clipHigh], the way scrolling moves content into view. A span
 * longer than the clip starts at its start.
 */
function computeShiftIntoView(
  low: number,
  high: number,
  clipLow: number,
  clipHigh: number,
): number {
  if (high - low >= clipHigh - clipLow || low < clipLow) return clipLow - low;
  return high > clipHigh ? clipHigh - high : 0;
}

/** Moves a rectangle by `delta` along one axis and cuts it to the span of `clip` along that axis. Returns null when nothing is left. */
function moveAndCutAlongAxis(
  rect: ProbeRect | null,
  axis: "x" | "y",
  delta: number,
  clip: ProbeRect,
): ProbeRect | null {
  if (rect === null) return null;
  return axis === "x"
    ? intersectRects(
        { ...rect, left: rect.left + delta, right: rect.right + delta },
        { left: clip.left, right: clip.right, top: -Infinity, bottom: Infinity },
      )
    : intersectRects(
        { ...rect, top: rect.top + delta, bottom: rect.bottom + delta },
        { left: -Infinity, right: Infinity, top: clip.top, bottom: clip.bottom },
      );
}

/**
 * Returns the part of a scroller's area that the user can see, or null when
 * none is left. It is the scroller's `clip`, cut along each axis by the outer
 * ancestors that cut along it and by the window, up to the first outer
 * ancestor that scrolls along that axis. Past that ancestor, the user scrolls
 * the scroller itself into view along the axis, and that ancestor gets its
 * own turn in `computeLostShare`. So a scroller below the fold of a page that
 * scrolls is not lost to the cutting ancestors around the page. `outer` holds
 * the ancestors around the scroller, innermost first.
 */
function computeVisibleScrollerArea(
  clip: ProbeRect,
  outer: ReadonlyArray<ClippingAncestor>,
  windowRect: ProbeRect,
): ProbeRect | null {
  let visible: ProbeRect | null = clip;
  let isScrolledX = false;
  let isScrolledY = false;
  for (const { facts, clip: outerClip } of outer) {
    if (facts.cutsX && !isScrolledX) visible = moveAndCutAlongAxis(visible, "x", 0, outerClip);
    if (facts.cutsY && !isScrolledY) visible = moveAndCutAlongAxis(visible, "y", 0, outerClip);
    isScrolledX ||= facts.scrollsX;
    isScrolledY ||= facts.scrollsY;
  }
  if (!isScrolledX) visible = moveAndCutAlongAxis(visible, "x", 0, windowRect);
  if (!isScrolledY) visible = moveAndCutAlongAxis(visible, "y", 0, windowRect);
  return visible;
}

/**
 * Returns the share of `box`, from 0 to 1, that is lost: cut off for good,
 * with no scrolling that reaches it. `ancestors` are the box's ancestors that
 * cut or scroll, innermost first, and `windowRect` is the window. The rules,
 * from the box outward:
 *
 * - An ancestor with overflow `hidden` or `clip` cuts the box along that axis.
 * - An ancestor that scrolls along an axis (overflow `auto` or `scroll`) lets
 *   the user scroll the box into view along that axis, but only into the
 *   part of the scroller the user can see (see `computeVisibleScrollerArea`).
 *   The walk moves the box into that part and goes on from there, so the
 *   ancestors around the scroller judge the box where scrolling puts it, not
 *   where it lies now. Along an axis that does not scroll, the scroller cuts
 *   like overflow `hidden`.
 * - A scroller whose visible part is empty (a panel placed outside the
 *   window) loses everything inside it, because no scrolling brings the
 *   content into view.
 * - The window cuts the box only when no ancestor scrolls.
 */
export function computeLostShare(
  box: ProbeRect,
  ancestors: ReadonlyArray<ClippingAncestor>,
  windowRect: ProbeRect,
): number {
  // `reference` is the box as scrolling would put it. The lost share is
  // what `kept` lacks of it, so moving a box into view loses nothing.
  let reference: ProbeRect | null = box;
  let kept: ProbeRect | null = box;
  let hasScroller = false;
  for (let index = 0; index < ancestors.length && kept !== null; index++) {
    const { facts, clip } = ancestors[index]!;
    if (facts.cutsX) kept = moveAndCutAlongAxis(kept, "x", 0, clip);
    if (facts.cutsY) kept = moveAndCutAlongAxis(kept, "y", 0, clip);
    if (!facts.scrollsX && !facts.scrollsY) continue;
    hasScroller = true;
    const view = computeVisibleScrollerArea(clip, ancestors.slice(index + 1), windowRect);
    if (view === null) return 1;
    if (facts.scrollsX && reference !== null) {
      const delta = computeShiftIntoView(reference.left, reference.right, view.left, view.right);
      reference = moveAndCutAlongAxis(reference, "x", delta, view);
      kept = moveAndCutAlongAxis(kept, "x", delta, view);
    }
    if (facts.scrollsY && reference !== null) {
      const delta = computeShiftIntoView(reference.top, reference.bottom, view.top, view.bottom);
      reference = moveAndCutAlongAxis(reference, "y", delta, view);
      kept = moveAndCutAlongAxis(kept, "y", delta, view);
    }
  }
  if (kept !== null && !hasScroller) kept = intersectRects(kept, windowRect);
  if (kept === null || reference === null) return 1;
  return Math.max(0, 1 - computeArea(kept) / computeArea(reference));
}
