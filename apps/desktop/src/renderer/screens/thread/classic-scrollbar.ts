import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * Returns whether the element in `ref` shows a classic scroll bar: one that
 * takes room at its right edge, as macOS draws while a mouse is attached and
 * the element's content overflows. Returns `false` for an overlay scroll
 * bar, which takes no room, and while the content fits. The element must
 * have no border, which would count as room taken.
 *
 * The thread header moves its rightmost pill clear of such a scroll bar, see
 * thread-header.css.
 *
 * Checks before the first paint, then again whenever the element's content
 * box changes size, which it does when a classic scroll bar comes or goes.
 */
export function useShowsClassicScrollbar(ref: RefObject<HTMLElement | null>): boolean {
  const [shows, setShows] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current!;
    const check = (): void => {
      setShows(element.offsetWidth > element.clientWidth);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return shows;
}
