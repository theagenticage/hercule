import { useEffect, type RefObject } from "react";
import { isTextField } from "../../app/text-field";

/**
 * Gives the keyboard focus to the element that scrolls a page, once, as the
 * page opens. A click on the sidebar leaves focus on the sidebar's row, which
 * is not the page, so the page's keys would never reach it. A text field that
 * has focus keeps it, and so does anything already focused inside the page
 * (a card the screen focused on its own). The element needs `tabIndex={-1}`
 * to take focus, and should draw no focus ring, as it is not a control.
 */
export const useFocusPageOnArrival = (scrollRef: RefObject<HTMLElement | null>): void => {
  useEffect(() => {
    const page = scrollRef.current;
    if (page === null || isTextField(document.activeElement)) return;
    if (!page.contains(document.activeElement)) page.focus({ preventScroll: true });
  }, [scrollRef]);
};
