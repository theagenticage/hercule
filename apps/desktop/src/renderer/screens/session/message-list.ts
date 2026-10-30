/**
 * What the thread's transcript and an assistant's Conversation share as
 * virtualized lists of a session's messages: where the first block starts,
 * the space under the last one, when the list follows new content, and how
 * a block is measured. Each list has its own virtualizer, because what it
 * holds and how it estimates a block differ; this module creates it, with
 * the options both lists share.
 *
 * Both open at the bottom and follow new content while the reader is there.
 * The browser's scroll anchoring is off (`overflow-anchor: none` on
 * `.transcript`, see transcript.css): Chromium anchored on the end of the
 * column even far below the view, and moved the view whenever content
 * below it changed height. Scripts keep the view in place instead, and
 * who does it depends on where the reader is, for changes in the size of
 * the content that nobody asked for:
 *
 * - Following the bottom: the observer in `useMessageList` scrolls to the
 *   bottom after each layout that resizes the column, the scrolling element
 *   or the composer's stack. The virtualizer's own correction for blocks that
 *   change height above the view is off, so the two do not both move it.
 * - Reading above the bottom: the virtualizer's correction keeps the view
 *   still when a block above it changes height. Nothing moves the view for
 *   a change below it.
 *
 * Other writers of the scroll position exist and are not part of that rule:
 * the virtualizer's initial offset and its retry of a scroll that the
 * browser clamped, `scrollToBottom`, the browser revealing a focused
 * element, and the reader's own scrolling.
 */
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useVirtualizer, type ReactVirtualizer } from "@tanstack/react-virtual";
import { useShowsClassicScrollbar } from "./classic-scrollbar";

/**
 * The space above the first block, under the floating header: the book's
 * `--header-clearance`, which floating-header.css sets on `.transcript`. The
 * two must be equal, because the virtualizer places the first block here.
 */
export const HEADER_CLEARANCE = 108;

/**
 * The space below the last block before the composer is measured: the
 * book's `.tx { padding-bottom: 360px }`, which transcript.css also sets.
 */
const DEFAULT_END_PADDING = 360;

/**
 * How many blocks are mounted beyond each end of the visible part, so a
 * short scroll shows no empty space before React draws the new blocks.
 */
const OVERSCAN = 6;

/** How far the composer's stack sits above the pane's bottom edge: `.composer-wrap`'s bottom padding. */
const COMPOSER_BOTTOM_OFFSET = 18;

/** The space between the last line and the composer, when scrolled to the bottom, as the book draws it. */
const LAST_LINE_CLEARANCE = 14;

/**
 * How close to the bottom, in CSS pixels, the reader must be for the list
 * to follow new content: the book's `atBottom`.
 */
const FOLLOW_THRESHOLD = 12;

/**
 * Returns false, so the virtualizer does not move the view when a block
 * changes height. It is assigned to the virtualizer's
 * `shouldAdjustScrollPositionOnItemSizeChange` while the list follows the
 * bottom, where the observer in `useMessageList` keeps the view instead.
 */
const skipSizeCompensation = (): boolean => false;

/**
 * Returns a mounted block's height as laid out, unrounded. The virtualizer's
 * own measure rounds it, and the spacers, built from the measured heights,
 * would then drift from the blocks they stand in for.
 */
const measureBlock = (element: Element, entry: ResizeObserverEntry | undefined): number =>
  entry?.borderBoxSize[0]?.blockSize ?? element.getBoundingClientRect().height;

/**
 * Checks whether something between `target` and `scroller` (the scroller
 * itself not included) scrolls vertically, like a step's output box. A wheel
 * over it scrolls that element, not the list.
 */
const isInsideVerticalScroller = (target: EventTarget | null, scroller: HTMLElement): boolean => {
  let element = target instanceof Element ? target : null;
  while (element !== null && element !== scroller) {
    if (element.scrollHeight > element.clientHeight) {
      const { overflowY } = getComputedStyle(element);
      if (overflowY === "auto" || overflowY === "scroll") return true;
    }
    element = element.parentElement;
  }
  return false;
};

/** What `useMessageList` returns to the list that calls it. */
export interface MessageList {
  /** The list's virtualizer. */
  readonly virtualizer: ReactVirtualizer<HTMLElement, Element>;
  /** The ref of the element that scrolls: the `.transcript` section. */
  readonly scrollRef: RefObject<HTMLElement | null>;
  /** The ref of the column inside it: the `.column.tx` element. */
  readonly columnRef: RefObject<HTMLDivElement | null>;
  /** True while the scrolling element shows a classic scroll bar: see `useShowsClassicScrollbar`. */
  readonly showsScrollbar: boolean;
  /** Notes where the reader is. Call it on every scroll event. */
  readonly noteScroll: () => void;
  /** Scrolls to the bottom at once, and follows new content from there. */
  readonly scrollToBottom: () => void;
  /**
   * Moves the view by `shift` pixels while the reader is above the bottom,
   * so the content they look at stays in place when content is inserted
   * above it. Does nothing while the list follows the bottom, because the
   * observer keeps the bottom instead.
   */
  readonly keepReadingPlace: (shift: number) => void;
}

/**
 * Creates the virtualizer of a list of a session's messages and keeps the
 * list at the bottom while the reader is there. It tells the caller when
 * the reader reaches the bottom or leaves it.
 *
 * - `count`, `estimateSize` and `getItemKey` are the virtualizer's options of
 *   the same names. The caller keeps `estimateSize` and `getItemKey` stable
 *   between renders, because the virtualizer measures the blocks again when
 *   either changes.
 * - `scrollMargin` is where the first block starts in the scrolling element.
 * - `composerStack` is the composer's stack, whose height sets the space
 *   below the last block, so the last line always clears the composer. It
 *   is `null` until the composer is mounted, and while the composer is
 *   shrunk: the space then stays as the expanded composer needs it, so
 *   shrinking changes nothing the reader can scroll to.
 * - `onBottomChange` is called when the reader reaches the bottom, or
 *   leaves it. The list opens at the bottom.
 *
 * Only a scroll up leaves the bottom. A scroll down that stops short of it
 * is the virtualizer's first scroll to its estimated bottom, whose event
 * can arrive after the blocks were measured taller than estimated; counting
 * it would shrink the composer of a list that was never scrolled.
 *
 * The reader comes back to the bottom by a scroll that ends within
 * `FOLLOW_THRESHOLD` of it, or by a wheel turn that would reach it. The
 * wheel needs its own check because the scroll event alone can miss the
 * bottom: Chromium applies a wheel scroll to an older layout than the main
 * thread has, and a streamed line that wraps adds 22.4px at once, so a
 * scroll that reached the bottom can end more than `FOLLOW_THRESHOLD` short
 * of the current one.
 */
export const useMessageList = ({
  count,
  estimateSize,
  getItemKey,
  scrollMargin,
  composerStack,
  onBottomChange,
}: {
  readonly count: number;
  readonly estimateSize: (index: number) => number;
  readonly getItemKey: (index: number) => string;
  readonly scrollMargin: number;
  readonly composerStack: HTMLElement | null;
  readonly onBottomChange: (atBottom: boolean) => void;
}): MessageList => {
  const scrollRef = useRef<HTMLElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const showsScrollbar = useShowsClassicScrollbar(scrollRef);
  // True while the reader is at the bottom. The list opens there.
  const followingRef = useRef(true);
  // Where the view was at the last scroll event, to tell a scroll up from a
  // scroll down.
  const lastScrollTopRef = useRef(0);

  // eslint-disable-next-line react-hooks/incompatible-library -- The virtualizer returns an object that changes inside while its identity stays the same, which the React Compiler cannot memoize, so the compiler leaves this hook alone, and the components that read the virtualizer opt out of it by hand.
  const virtualizer = useVirtualizer<HTMLElement, Element>({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    measureElement: measureBlock,
    overscan: OVERSCAN,
    scrollMargin,
    // The list fills the pane, so the window's height is close to its own
    // until the virtualizer measures it.
    initialRect: { width: 0, height: window.innerHeight },
    // The estimated scroll position of the bottom, so the first render
    // mounts the last blocks rather than the first. Read once, when the
    // virtualizer is created.
    initialOffset: () => {
      let height = scrollMargin + DEFAULT_END_PADDING;
      for (let index = 0; index < count; index += 1) height += estimateSize(index);
      return Math.max(0, height - window.innerHeight);
    },
  });

  // After every commit, makes the virtualizer stop observing the blocks that
  // React removed. Its own cleanup runs while the last removed block is still
  // attached, so that block stays observed. Its size then drops to zero in the
  // middle of a resize observer delivery, and Chromium reports "ResizeObserver
  // loop completed with undelivered notifications". Calling `measureElement`
  // with `null` is the virtualizer's way to drop every disconnected block.
  // There is deliberately no dependency array: blocks can be removed by any
  // commit.
  useLayoutEffect(() => {
    virtualizer.measureElement(null);
  });

  // The list opens following, so the virtualizer must not correct for block
  // sizes from its first measurement on. A state initializer runs once, in
  // the first render, after the virtualizer exists and before any block is
  // measured (blocks are measured when React attaches their refs).
  useState(() => {
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = skipSizeCompensation;
  });

  /**
   * Changes whether the list follows the bottom, and tells the caller. While
   * following, the observer keeps the view at the bottom and the
   * virtualizer's correction for block sizes is off. While reading, the
   * virtualizer's default correction (`undefined`) is on. Does nothing when
   * the state does not change.
   */
  const setFollowing = (following: boolean): void => {
    if (following === followingRef.current) return;
    followingRef.current = following;
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = following
      ? skipSizeCompensation
      : undefined;
    onBottomChange(following);
  };

  // One observer for everything that moves the bottom:
  // - the composer's stack, whose height sets the space under the last block;
  // - the column, which grows as blocks grow, are added, or are measured;
  // - the scrolling element itself, which changes height with the window.
  // The callback runs after layout and before paint, so the new space and
  // the scroll to the bottom show in the same frame as the change.
  // While the list follows the bottom, this scroll is what keeps the view
  // there: the browser's scroll anchoring is off. It also covers the first
  // render, and a reader a few pixels above the bottom, who counts as
  // following.
  useLayoutEffect(() => {
    const scroller = scrollRef.current!;
    const column = columnRef.current!;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target !== composerStack) continue;
        // Rounded, so the bottom lands on a whole pixel as the book's 360px does.
        const stackHeight = entry.borderBoxSize[0]?.blockSize ?? 0;
        column.style.paddingBottom = `${Math.round(stackHeight + COMPOSER_BOTTOM_OFFSET + LAST_LINE_CLEARANCE)}px`;
      }
      // The browser clamps this to the bottom, which can be a fraction of a
      // pixel below `scrollHeight - clientHeight`, a whole number. Setting
      // that number would leave the view a fraction short of the bottom,
      // and show the scroll bar.
      if (followingRef.current) {
        scroller.scrollTop = scroller.scrollHeight;
        // Noted here too, because the scroll event of this scroll can be
        // merged with a later one: a jump up right after it must still
        // count as a scroll up.
        lastScrollTopRef.current = scroller.scrollTop;
      }
    });
    observer.observe(scroller);
    observer.observe(column);
    if (composerStack !== null) observer.observe(composerStack);
    return () => {
      observer.disconnect();
    };
  }, [composerStack]);

  // An effect event reads the latest `setFollowing`, so the listener below
  // is added once and not again on every render.
  const followWheelToBottom = useEffectEvent((event: WheelEvent): void => {
    if (followingRef.current) return;
    // Other units (lines, pages) are left to `noteScroll`. A modified wheel
    // zooms or scrolls sideways, and a handled one does not scroll the list.
    if (
      event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL ||
      event.deltaY <= 0 ||
      event.ctrlKey ||
      event.shiftKey ||
      event.defaultPrevented
    ) {
      return;
    }
    const scroller = scrollRef.current!;
    const bottom = scroller.scrollHeight - scroller.clientHeight;
    // Cheapest checks first: `getComputedStyle` runs only near the bottom.
    if (scroller.scrollTop + event.deltaY < bottom - FOLLOW_THRESHOLD) return;
    if (isInsideVerticalScroller(event.target, scroller)) return;
    setFollowing(true);
  });

  useEffect(() => {
    const scroller = scrollRef.current!;
    scroller.addEventListener("wheel", followWheelToBottom, { passive: true });
    return () => {
      scroller.removeEventListener("wheel", followWheelToBottom);
    };
  }, []);

  const noteScroll = (): void => {
    const scroller = scrollRef.current!;
    const atBottom =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < FOLLOW_THRESHOLD;
    const following =
      atBottom || (followingRef.current && scroller.scrollTop >= lastScrollTopRef.current);
    lastScrollTopRef.current = scroller.scrollTop;
    setFollowing(following);
  };

  const scrollToBottom = (): void => {
    const scroller = scrollRef.current!;
    scroller.scrollTop = scroller.scrollHeight;
    // Noted at once rather than on the scroll event, so the composer
    // expands in the same frame.
    noteScroll();
  };

  const keepReadingPlace = (shift: number): void => {
    if (followingRef.current) return;
    scrollRef.current!.scrollTop += shift;
  };

  return {
    virtualizer,
    scrollRef,
    columnRef,
    showsScrollbar,
    noteScroll,
    scrollToBottom,
    keepReadingPlace,
  };
};
