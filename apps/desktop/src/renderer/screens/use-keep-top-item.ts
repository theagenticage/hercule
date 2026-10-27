import { useLayoutEffect, useMemo, useRef } from "react";

/** The part of a TanStack virtualizer that `useKeepTopItem` uses. */
interface Placed {
  /**
   * The place and size of every item, as of the last render that placed them.
   * Its items are built when read, from numbers the virtualizer overwrites
   * when it places the items again, so an item read earlier must be copied.
   */
  readonly measurementsCache: ReadonlyArray<{ readonly start: number; readonly size: number }>;
  /** How far the scroll element is scrolled, as of its last scroll event, or `null` before it is known. */
  readonly scrollOffset: number | null;
  readonly scrollElement: Element | Window | null;
}

/** The item that holds the top edge of the view. */
interface TopItem {
  readonly index: number;
  /** The item's size when it was noted, in pixels. */
  readonly size: number;
  /** How far into the item the view starts, in pixels. */
  readonly within: number;
}

/**
 * Returns the item that holds `offset`, found by binary search over the
 * items' places, or `null` when `offset` is at the top, where nothing needs
 * to be kept in place, or no item is placed.
 */
const findTopItem = (items: Placed["measurementsCache"], offset: number): TopItem | null => {
  if (offset <= 0 || items.length === 0) return null;
  // The last item that starts at or above the top edge.
  let low = 0;
  let high = items.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (items[middle]!.start <= offset) low = middle;
    else high = middle - 1;
  }
  const item = items[low]!;
  return { index: low, size: item.size, within: offset - item.start };
};

/**
 * Scrolls the virtualizer's scroll element so that `top` holds the top edge
 * of the view again, by the same share of its size, and returns how far the
 * element is scrolled then, which the browser may have rounded or limited.
 * Returns `null`, and scrolls nothing, when the item or the element is gone.
 */
const scrollToTopItem = (virtualizer: Placed, top: TopItem): number | null => {
  const element = virtualizer.scrollElement;
  const item = virtualizer.measurementsCache[top.index];
  if (!(element instanceof Element) || item === undefined) return null;
  element.scrollTop = item.start + (top.within * item.size) / top.size;
  return element.scrollTop;
};

/**
 * Returns a function that returns what `readKey` returns. `sizes` is not
 * used: it is a parameter so that the result is a new function for each new
 * `sizes`, which a function written in `useItemKeyOfSizes` would leave to the
 * React Compiler to decide.
 */
const buildItemKeyReader = (
  readKey: (index: number) => string,
  sizes: unknown,
): ((index: number) => string) => {
  void sizes;
  return (index) => readKey(index);
};

/**
 * Returns the `getItemKey` option for a virtualizer: a function that returns
 * what `readKey` returns, and is a new function whenever `readKey` or `sizes`
 * is new.
 *
 * A virtualizer places its items again whenever its `getItemKey` changes, and
 * not when its `estimateSize` does. A list whose item heights follow the Text
 * size gets new heights with the same items, so it passes the heights as
 * `sizes`, and the virtualizer places the items by them in that same render.
 */
export function useItemKeyOfSizes(
  readKey: (index: number) => string,
  sizes: unknown,
): (index: number) => string {
  return useMemo(() => buildItemKeyReader(readKey, sizes), [readKey, sizes]);
}

/**
 * Keeps the item at the top of the view at the top when `sizes` changes from
 * one render to the next. Does nothing on the first render.
 *
 * The virtualizer places the items by the new heights in that same render
 * (`useItemKeyOfSizes`), but the scroll position is in pixels, so a list
 * scrolled far down would show other items. This scrolls in a layout effect,
 * before the browser paints, and the scroll event then draws the list again
 * at the right place.
 *
 * Every commit notes the item at the top of the view, which costs a binary
 * search, because by the time the sizes have changed the old places are gone.
 * The virtualizer learns the new scroll position only from the scroll event,
 * which comes after the commit. Until it does, `scrollOffset` is the old
 * position, so the item noted after a scroll is the one found from the
 * position the element reports, and commits keep it until the offset moves.
 * Otherwise a second change of the sizes before the event would keep the item
 * the old position holds in the new places.
 */
export function useKeepTopItem(virtualizer: Placed, sizes: unknown): void {
  const topBefore = useRef<TopItem | null>(null);
  const sizesBefore = useRef(sizes);
  // The offset the virtualizer held when this hook scrolled, while its scroll
  // event has not arrived, or `null`.
  const offsetBeforeScroll = useRef<number | null>(null);
  useLayoutEffect(() => {
    const items = virtualizer.measurementsCache;
    const offset = virtualizer.scrollOffset ?? 0;
    if (sizesBefore.current !== sizes) {
      sizesBefore.current = sizes;
      const top = topBefore.current;
      const scrolledTo = top === null ? null : scrollToTopItem(virtualizer, top);
      if (scrolledTo !== null && Math.abs(scrolledTo - offset) > 0.01) {
        offsetBeforeScroll.current ??= offset;
        topBefore.current = findTopItem(items, scrolledTo);
        return;
      }
    }
    if (offsetBeforeScroll.current !== null) {
      if (offset === offsetBeforeScroll.current) return;
      offsetBeforeScroll.current = null;
    }
    topBefore.current = findTopItem(items, offset);
  });
}
