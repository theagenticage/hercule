import { useEffect, useState, type RefObject } from "react";

/**
 * Returns how far below the top of `scrollRef`'s scrolled content the element
 * `listRef` starts, in pixels, and measures it again whenever the element
 * `aboveRef` changes size. `aboveRef` is the part of the content above the
 * list, such as a heading, so a change in its height, which the Text size
 * and a narrow window cause, moves the list.
 *
 * A virtual list that shares its scroll with something above it needs this
 * to tell which of its lines the scroll position reaches. It is 0 until the
 * elements are measured.
 *
 * The measure runs in an effect, not a layout effect, because the scroll
 * area is usually a parent of the list: React attaches a parent's ref after
 * the layout effects of its children. The first measure always draws the list
 * again, even when the result is 0, which is also what lets the list's
 * virtualizer find a scroll area that was not attached when it first drew.
 */
export const useListTop = (
  scrollRef: RefObject<HTMLElement | null>,
  aboveRef: RefObject<HTMLElement | null>,
  listRef: RefObject<HTMLElement | null>,
): number => {
  const [top, setTop] = useState<number | undefined>(undefined);
  useEffect(() => {
    const scroll = scrollRef.current;
    const above = aboveRef.current;
    const list = listRef.current;
    if (scroll === null || above === null || list === null) return;
    const measure = (): void => {
      setTop(
        Math.round(
          list.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop,
        ),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(above);
    return () => {
      observer.disconnect();
    };
  }, [scrollRef, aboveRef, listRef]);
  return top ?? 0;
};
