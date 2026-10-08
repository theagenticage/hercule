import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";
import type { SidebarItem } from "./sidebar-items";
import type { ThreadHoverDetails, ThreadHoverPlacement } from "./thread-hover-card";

/** How long the pointer rests on a thread row before its card shows, in milliseconds. */
const HOVER_DELAY_MS = 400;

/** The space between the sidebar's right edge and the card, in CSS pixels. */
const SIDEBAR_GAP = 8;

/** The handlers the thread list's `nav` takes, so the list watches every row at once. */
export interface ThreadHoverHandlers {
  readonly onPointerOver: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerOut: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly onScroll: () => void;
}

/** Returns the `data-key` of the list item that contains `target`, or `null` when no item does. */
const findItemKey = (target: EventTarget | null): string | null =>
  target instanceof Element
    ? (target.closest("[data-key]")?.getAttribute("data-key") ?? null)
    : null;

/**
 * Measures where the card of the row `key` goes: 8px to the right of `list`,
 * the sidebar's thread list, level with the row's top. Returns `null` when the
 * list does not draw the row, because its item left the list or scrolled out
 * of the part the list mounts.
 */
const placeBesideRow = (list: HTMLElement, key: string): ThreadHoverPlacement | null => {
  const row = [...list.querySelectorAll<HTMLElement>("[data-key]")].find(
    (element) => element.dataset.key === key,
  );
  return row === undefined
    ? null
    : {
        key,
        left: list.getBoundingClientRect().right + SIDEBAR_GAP,
        top: row.getBoundingClientRect().top,
      };
};

/**
 * Decides when the sidebar's card of details shows, and for which thread
 * row. `listRef` is the list's `nav`. Returns the handlers to put on that
 * `nav`, where the card shows, or `null` while it is hidden, and the details
 * of the thread whose card shows.
 *
 * - The card shows once the pointer has rested on a thread row for 400ms.
 * - While the card shows, moving to another thread row switches it at once.
 * - Moving to any other item, past the end of the list or out of it hides
 *   it at once, and so do a press on the list and a scroll of the list. In
 *   the space between two items, a card that shows stays, and a card that
 *   waits for the delay is cancelled.
 * - After a press, the pressed row's card does not come back until the
 *   pointer moves to another row or leaves the list.
 * - When `items` change, the card is measured again, so it stays beside its
 *   row when rows above it arrive or leave. When its row is no longer drawn,
 *   the card hides.
 *
 * The rows are watched through events on the list, not a listener per row.
 * The only timer is the hover delay, which runs only while the pointer rests
 * on a row whose card does not show yet.
 */
export const useThreadHover = (
  items: readonly SidebarItem[],
  listRef: RefObject<HTMLElement | null>,
): {
  readonly listHandlers: ThreadHoverHandlers;
  readonly placement: ThreadHoverPlacement | null;
  readonly details: ThreadHoverDetails | null;
} => {
  const [placement, setPlacement] = useState<ThreadHoverPlacement | null>(null);
  // The placement last asked for. The handlers read it, not `placement`,
  // because `placement` holds the value of the last render, and misses an
  // update React has not drawn yet.
  const shown = useRef<ThreadHoverPlacement | null>(null);
  // The row the pointer rests on while its card waits for the delay.
  const waiting = useRef<{ readonly key: string; readonly timer: number } | null>(null);
  // The row the last press was on, whose card stays hidden until the pointer
  // moves to another row.
  const pressedKey = useRef<string | null>(null);

  const show = (next: ThreadHoverPlacement | null): void => {
    shown.current = next;
    setPlacement(next);
  };

  const cancelWaiting = (): void => {
    if (waiting.current === null) return;
    window.clearTimeout(waiting.current.timer);
    waiting.current = null;
  };

  const hide = (): void => {
    cancelWaiting();
    if (shown.current !== null) show(null);
  };

  useEffect(
    () => () => {
      if (waiting.current !== null) window.clearTimeout(waiting.current.timer);
    },
    [],
  );

  // Measured before the browser paints, so the card never shows beside a
  // row that has moved. A placement that did not change is kept, so the card
  // does not lay itself out again.
  useLayoutEffect(() => {
    const current = shown.current;
    const list = listRef.current;
    if (current === null || list === null) return;
    const next = placeBesideRow(list, current.key);
    if (next?.left === current.left && next.top === current.top) return;
    shown.current = next;
    setPlacement(next);
  }, [items, listRef]);

  const listHandlers: ThreadHoverHandlers = {
    onPointerOver: (event) => {
      const list = event.currentTarget;
      const key = findItemKey(event.target);
      if (key === null) {
        // The pointer is in the space between two items, or past the end of
        // the list. Between two rows, a card that shows stays, so moving to
        // the next row still switches it at once.
        cancelWaiting();
        if (event.target === list) hide();
        return;
      }
      // The pointer moved between the parts of the row it pressed.
      if (key === pressedKey.current) return;
      pressedKey.current = null;
      const item = items.find((each) => each.key === key);
      if (item?.kind !== "thread-row") {
        hide();
        return;
      }
      if (shown.current !== null) {
        if (shown.current.key !== key) show(placeBesideRow(list, key));
        return;
      }
      // The pointer moved between the parts of the row it already rests on.
      if (waiting.current?.key === key) return;
      cancelWaiting();
      waiting.current = {
        key,
        timer: window.setTimeout(() => {
          waiting.current = null;
          show(placeBesideRow(list, key));
        }, HOVER_DELAY_MS),
      };
    },
    onPointerOut: (event) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
        pressedKey.current = null;
        hide();
      }
    },
    onPointerDown: (event) => {
      pressedKey.current = findItemKey(event.target);
      hide();
    },
    onScroll: hide,
  };

  const hoveredItem =
    placement === null ? undefined : items.find((item) => item.key === placement.key);
  // The card of a thread that left the list never draws, also in the render
  // before the layout effect above hides it.
  const details = hoveredItem?.kind === "thread-row" ? hoveredItem.details : null;
  return { listHandlers, placement: details === null ? null : placement, details };
};
