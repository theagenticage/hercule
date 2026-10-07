/**
 * What the thread's transcript and an assistant's Conversation share as
 * virtualized lists of a session's messages: where the first block starts,
 * the space under the last one, when the list follows new content, and how
 * a block is measured. Each list keeps its own virtualizer, because what it
 * holds and how it estimates a block differ.
 *
 * Both open at the bottom and follow new content while the reader is there.
 * While the reader is at the bottom, the browser's scroll anchoring keeps
 * the view there, on `.transcript-end` below the column (see
 * transcript.css).
 */
import { useLayoutEffect, useRef, type RefObject } from "react";
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
export const DEFAULT_END_PADDING = 360;

/**
 * How many blocks are mounted beyond each end of the visible part, so a
 * short scroll shows no empty space before React draws the new blocks.
 */
export const OVERSCAN = 6;

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
 * Returns a mounted block's height as laid out, unrounded. The virtualizer's
 * own measure rounds it, and the spacers, built from the measured heights,
 * would then drift from the blocks they stand in for.
 */
export const measureBlock = (element: Element, entry: ResizeObserverEntry | undefined): number =>
  entry?.borderBoxSize[0]?.blockSize ?? element.getBoundingClientRect().height;

/** What `useMessageList` returns to the list that calls it. */
export interface MessageList {
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
}

/**
 * Keeps a list of a session's messages at the bottom while the reader is
 * there, and tells the caller when the reader reaches the bottom or leaves
 * it.
 *
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
 */
export const useMessageList = ({
  composerStack,
  onBottomChange,
}: {
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

  // One observer for everything that moves the bottom:
  // - the composer's stack, whose height sets the space under the last block;
  // - the column, which grows as blocks grow, are added, or are measured;
  // - the scrolling element itself, which changes height with the window.
  // The callback runs after layout and before paint, so the new space and
  // the scroll to the bottom show in the same frame as the change.
  // Anchoring has usually kept the view at the bottom already, and then the
  // scroll below changes nothing. It is needed where anchoring does not act:
  // the first render, and a reader a few pixels above the bottom, where the
  // end is out of view.
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
      // that number would move the view by the fraction, and show the scroll
      // bar, after every change anchoring has already followed.
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

  const noteScroll = (): void => {
    const scroller = scrollRef.current!;
    const atBottom =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < FOLLOW_THRESHOLD;
    const following =
      atBottom || (followingRef.current && scroller.scrollTop >= lastScrollTopRef.current);
    lastScrollTopRef.current = scroller.scrollTop;
    if (following === followingRef.current) return;
    followingRef.current = following;
    onBottomChange(following);
  };

  const scrollToBottom = (): void => {
    const scroller = scrollRef.current!;
    scroller.scrollTop = scroller.scrollHeight;
    // Noted at once rather than on the scroll event, so the composer
    // expands in the same frame.
    noteScroll();
  };

  return { scrollRef, columnRef, showsScrollbar, noteScroll, scrollToBottom };
};
