/**
 * A virtualized list in a `nav` landmark that scrolls: the sidebar's list and
 * the workflow list.
 *
 * Only the items in and near the visible part of the list are mounted, so a
 * list of a thousand items costs about what a list of forty costs. The caller
 * gives each item a fixed height, so the list measures nothing: an item's
 * place follows from the items above it.
 *
 * The mounted items are stacked in normal flow, and an empty spacer stands in
 * for each run of items that is not mounted. No item takes its position as a
 * prop, so when an item arrives, the items below it move down without
 * drawing again.
 *
 * The focused item is always mounted, even when it scrolls far out of view,
 * so keyboard focus is never lost to the page. When the focused item leaves
 * the list, focus moves to the item the caller's `pickFocusFallback` picks.
 */
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type ComponentProps,
  type FocusEvent,
  type JSX,
  type ReactNode,
  type RefObject,
} from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import "./virtual-list.css";

/**
 * How many items the list mounts beyond each end of the visible part, so a
 * short scroll shows no empty space before React draws the new items.
 */
const OVERSCAN = 8;

/** The item that holds keyboard focus. */
interface Focus {
  /** The item's key, or `null` when focus is outside the list. */
  readonly key: string | null;
  /**
   * True when the list picked the item itself, because the focused item left
   * the list. The item is focused as soon as it is mounted.
   */
  readonly restore: boolean;
}

const NO_FOCUS: Focus = { key: null, restore: false };

/** Returns the `data-key` of the item that contains `element`, or `null` when no item does. */
const findItemKey = (element: Element): string | null =>
  element.closest("[data-key]")?.getAttribute("data-key") ?? null;

/**
 * Renders `items` virtualized in a `nav` that scrolls, with `head` above them
 * and `children` after them, in the same scroll.
 *
 * - Each item's `key` is unique in the list and stays the same for the same
 *   thing across renders. The element `renderItem` returns carries the key as
 *   its React key, and its root, or an element inside it that takes focus,
 *   carries it as `data-key`, which the list finds the focused item by.
 * - `computeItemHeight` returns an item's height in CSS pixels, the space
 *   above it included, which the item must draw exactly. The list places
 *   the items again only when `items` changes, so the function must keep its
 *   identity across renders and return the same height for the same `items`.
 * - `renderItem` returns the element that draws an item, told whether the
 *   item is in the visible part of the list, without the items mounted beyond
 *   it.
 * - `pickFocusFallback` returns the key of the item to focus when the focused
 *   item, `goneKey`, leaves the list, or `null` to focus nothing. `before` is
 *   the list that held the item and `after` the list without it.
 * - `head` is drawn above the items, `height` pixels tall, and sticks to the
 *   top while the items scroll under it. An item that takes focus is
 *   scrolled clear of it.
 * - `scrollRef` is set to the `nav`, which scrolls the items.
 */
export function VirtualList<Item extends { readonly key: string }>({
  items,
  computeItemHeight,
  renderItem,
  pickFocusFallback,
  head,
  scrollRef,
  className,
  children,
  ...navProps
}: Pick<
  ComponentProps<"nav">,
  "id" | "aria-label" | "onPointerOver" | "onPointerOut" | "onPointerDown" | "onScroll"
> & {
  readonly items: readonly Item[];
  readonly computeItemHeight: (item: Item, index: number) => number;
  readonly renderItem: (item: Item, index: number, onScreen: boolean) => JSX.Element;
  readonly pickFocusFallback: (
    goneKey: string,
    before: readonly Item[],
    after: readonly Item[],
  ) => string | null;
  readonly head?: { readonly height: number; readonly content: ReactNode };
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly className?: string;
  readonly children?: ReactNode;
}): JSX.Element {
  const [focus, setFocus] = useState<Focus>(NO_FOCUS);
  const headHeight = head?.height ?? 0;

  // When the focused item leaves the list, the next item to focus is picked
  // while rendering the new list, not in an effect after it, so the item is
  // mounted in the same commit and focus never falls to the page between.
  const [shownItems, setShownItems] = useState(items);
  if (shownItems !== items) {
    setShownItems(items);
    if (focus.key !== null && !items.some((item) => item.key === focus.key)) {
      setFocus({ key: pickFocusFallback(focus.key, shownItems, items), restore: true });
    }
  }

  const focusedIndex = useMemo(
    () => (focus.key === null ? -1 : items.findIndex((item) => item.key === focus.key)),
    [items, focus.key],
  );

  // The React Compiler does not memoize this component, because it cannot
  // see into the virtualizer (see below). These callbacks are memoized by
  // hand: the virtualizer places the items again whenever `getItemKey`
  // changes, and draws the list again whenever `rangeExtractor` changes.
  const rangeExtractor = useCallback(
    (range: Range): number[] => {
      const indexes = defaultRangeExtractor(range);
      if (focusedIndex < 0 || indexes.includes(focusedIndex)) return indexes;
      // In list order, so the focused item keeps its place in the tab order.
      return [...indexes, focusedIndex].sort((a, b) => a - b);
    },
    [focusedIndex],
  );
  // The virtualizer asks only for indexes below `count`, which is
  // `items.length`.
  const getItemKey = useCallback((index: number) => items[index]!.key, [items]);
  const estimateSize = useCallback(
    (index: number) => computeItemHeight(items[index]!, index),
    [items, computeItemHeight],
  );

  // eslint-disable-next-line react-hooks/incompatible-library -- The virtualizer returns an object that changes inside while its identity stays the same, which the React Compiler cannot memoize, so the compiler leaves this component alone. The callbacks above and the memoized rows keep the renders cheap instead.
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    rangeExtractor,
    overscan: OVERSCAN,
    // The head sits in the scrolling element above the items.
    scrollMargin: headHeight,
  });

  useLayoutEffect(() => {
    if (!focus.restore || focus.key === null) return;
    const elements = scrollRef.current?.querySelectorAll<HTMLElement>("[data-key]") ?? [];
    [...elements].find((element) => element.dataset.key === focus.key)?.focus();
  }, [focus, scrollRef]);

  const noteFocus = (event: FocusEvent<HTMLElement>): void => {
    setFocus({ key: findItemKey(event.target), restore: false });
  };

  const noteBlur = (event: FocusEvent<HTMLElement>): void => {
    const next = event.relatedTarget;
    if (next !== null) {
      // Focus moved to another element. Inside the list, `noteFocus` notes
      // the new item.
      if (!event.currentTarget.contains(next)) setFocus(NO_FOCUS);
      return;
    }
    // Focus moved to no element, for one of two reasons:
    // - the window lost focus, and focus comes back to the same item when the
    //   window is active again;
    // - the user clicked something that takes no focus, and focus left the
    //   list.
    // The window's focus is read once the blur has been handled, so the check
    // does not depend on whether the browser marks the window inactive before
    // or after it sends the blur.
    // React sends no blur for an item it removes, because it ignores events
    // while it commits; the list picks the next item while rendering instead.
    const key = findItemKey(event.target);
    queueMicrotask(() => {
      if (document.hasFocus()) {
        setFocus((current) => (current.key === key ? NO_FOCUS : current));
      }
    });
  };

  // The mounted items in list order. Before each run of items that is not
  // mounted, an empty spacer takes up the run's height. An item's `start`
  // counts the head above the items, which the spacers do not.
  const drawn: JSX.Element[] = [];
  const virtualItems = virtualizer.getVirtualItems();
  // The visible part of the list, without the overscan. Read after
  // `getVirtualItems`, which computes it.
  const visible = virtualizer.range;
  let end = headHeight;
  for (const { index, key, start, size } of virtualItems) {
    if (start > end) drawn.push(<div key={`gap:${key}`} style={{ height: start - end }} />);
    const onScreen = visible !== null && index >= visible.startIndex && index <= visible.endIndex;
    drawn.push(renderItem(items[index]!, index, onScreen));
    end = start + size;
  }

  return (
    <nav
      ref={scrollRef}
      className={className === undefined ? "virtual-list" : `virtual-list ${className}`}
      // The browser scrolls a focused item into view on its own, when the
      // user tabs to it and when the list moves focus itself. The padding
      // makes it stop below the head, so the head never covers that item.
      style={{ scrollPaddingTop: headHeight }}
      onFocus={noteFocus}
      onBlur={noteBlur}
      {...navProps}
    >
      {head !== undefined && (
        <div className="virtual-list-head" style={{ height: head.height }}>
          {head.content}
        </div>
      )}
      {items.length > 0 && (
        <div className="virtual-list-items" style={{ height: virtualizer.getTotalSize() }}>
          {drawn}
        </div>
      )}
      {children}
    </nav>
  );
}
