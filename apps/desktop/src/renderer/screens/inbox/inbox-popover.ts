import { useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import "./inbox-popover.css";

/** What `useInboxPopover` returns: the ref and the props the popover's element takes, which draw it as `.inbox-popover`. */
interface InboxPopoverProps {
  readonly ref: RefObject<HTMLDivElement | null>;
  readonly popover: "auto";
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onToggle: (event: { readonly newState: string }) => void;
}

/**
 * Gives a menu in the Inbox the behaviour every one of them shares, and
 * returns the props to spread on its root element (which also takes the class
 * `inbox-popover`, the shared surface). The parent renders the menu only
 * while it is open.
 *
 * - The element is a popover on `body`'s top layer, shown when it mounts and
 *   placed by `place(menu, anchor)`. A glass element traps z-index and blur,
 *   so a menu never lives inside one.
 * - A click outside it calls `onClose` (light dismiss).
 * - It owns the keyboard: no key reaches the page behind it. Esc calls
 *   `onClose`; every other key goes to `onKey`, which the menu uses for its
 *   own keys.
 * - When it goes, the focus returns to what had it when the menu opened, or
 *   to `anchor` when that is gone.
 */
export function useInboxPopover({
  anchor,
  place,
  onKey,
  onClose,
}: {
  readonly anchor: HTMLElement;
  readonly place: (menu: HTMLElement, anchor: HTMLElement) => void;
  readonly onKey: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onClose: () => void;
}): InboxPopoverProps {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (menu === null) return;
    const before = document.activeElement;
    menu.showPopover();
    place(menu, anchor);
    return () => {
      const back = before instanceof HTMLElement && before.isConnected ? before : anchor;
      if (back.isConnected) back.focus({ preventScroll: true });
    };
  }, [anchor, place]);

  return {
    ref,
    popover: "auto",
    onKeyDown: (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      onKey(event);
    },
    onToggle: (event) => {
      if (event.newState === "closed") onClose();
    },
  };
}
