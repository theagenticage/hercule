import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { findCardElement, readCardId } from "./inbox-page-dom";

/** How long the page takes to close up after a move, in milliseconds. A hit test in that time lands on a moving target. */
const SETTLE_MS = 320;

/** How far the pointer must travel from where the keys took over before it takes the current card back, in pixels. */
const POINTER_TAKEOVER = 12;

/** Who made a card the current one. */
export type CurrentBy = "pointer" | "keys";

/** The current card and who made it current. */
interface Current {
  readonly id: string;
  readonly by: CurrentBy;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** What `useCurrentCard` returns. */
export interface CurrentCard {
  /** Returns the current card, or `null` when there is none. */
  readonly read: () => Current | null;
  /**
   * Makes the card `id` the current one, or no card for `null`, and marks it
   * with `data-current`. Its moves show then. By the keys, the card also takes
   * focus and scrolls into view, unless `takesFocus` is false, as while a
   * sheet that holds the focus is open. A card that is not on the page leaves
   * no current card.
   */
  readonly set: (id: string | null, by: CurrentBy, takesFocus?: boolean) => void;
  /**
   * Gives the pointer's current card to `id`, the card that takes the place
   * of one that just left. The pointer is not asked what lies under it until
   * the page has closed up (320ms), because while it moves that is a moving
   * target. Then the card under the pointer is read from where it rests.
   */
  readonly handOver: (id: string | null) => void;
}

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Holds the one current card of the Inbox page, shared by the pointer and the
 * keys: the card the next key acts on, and the one whose moves show. It
 * follows the pointer while the pointer travels over cards, and the keys
 * while they walk.
 *
 * - The pointer takes the current card by reaching a card. Passing over empty
 *   desk leaves the keys' card where it is, and a pointer resting near where
 *   the keys took over (12px) does not take it back.
 * - The mark is the page's own and does not wait for the browser's `:hover`,
 *   which names whatever lies under the pointer, even a card that is moving
 *   away.
 *
 * The listeners are on the element `scrollRef` holds, and need no re-render:
 * the mark is an attribute on the card.
 */
export const useCurrentCard = (scrollRef: RefObject<HTMLElement | null>): CurrentCard => {
  const current = useRef<Current | null>(null);
  const pointerAt = useRef<Point | null>(null);
  const keysAt = useRef<Point>({ x: 0, y: 0 });
  const settledUntil = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const set = (id: string | null, by: CurrentBy, takesFocus = true): void => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    const before = current.current;
    if (before !== null) findCardElement(scroller, before.id)?.removeAttribute("data-current");
    current.current = null;
    if (id === null) return;
    const element = findCardElement(scroller, id);
    if (element === null) return;
    current.current = { id, by };
    element.setAttribute("data-current", by);
    if (by === "pointer") {
      // The ring and the pointer's mark must not both stand: the pointer took over.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && scroller.contains(focused)) focused.blur();
      return;
    }
    keysAt.current = pointerAt.current ?? keysAt.current;
    if (!takesFocus) return;
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "nearest" });
  };

  /** Reads the card under the pointer where it rests, once the page has closed up. */
  const readUnderPointer = (): void => {
    const at = pointerAt.current;
    if (at === null || current.current?.by === "keys") return;
    set(readCardId(document.elementFromPoint(at.x, at.y)), "pointer");
  };

  const waitForSettle = (): void => {
    if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(
      readUnderPointer,
      Math.max(0, settledUntil.current - performance.now()) + 10,
    );
  };

  const handleMove = (event: PointerEvent): void => {
    pointerAt.current = { x: event.clientX, y: event.clientY };
    const before = current.current;
    if (before?.by === "keys" && distance(pointerAt.current, keysAt.current) < POINTER_TAKEOVER) {
      return;
    }
    if (performance.now() < settledUntil.current) {
      waitForSettle();
      return;
    }
    const id = event.target instanceof Element ? readCardId(event.target) : null;
    if (id === null) {
      if (before?.by === "pointer") set(null, "pointer");
      return;
    }
    if (before?.id !== id || before.by !== "pointer") set(id, "pointer");
  };

  const handleLeave = (): void => {
    pointerAt.current = null;
    if (current.current?.by === "pointer") set(null, "pointer");
  };

  // The listeners are added once and call the newest handlers, which read the newest refs.
  const handlers = useRef({ handleMove, handleLeave });
  useLayoutEffect(() => {
    handlers.current = { handleMove, handleLeave };
  });
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller === null) return;
    const move = (event: PointerEvent): void => {
      handlers.current.handleMove(event);
    };
    const leave = (): void => {
      handlers.current.handleLeave();
    };
    scroller.addEventListener("pointermove", move);
    scroller.addEventListener("pointerleave", leave);
    return () => {
      scroller.removeEventListener("pointermove", move);
      scroller.removeEventListener("pointerleave", leave);
      if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    };
  }, [scrollRef]);

  return {
    read: () => current.current,
    set,
    handOver: (id) => {
      settledUntil.current = performance.now() + SETTLE_MS;
      set(id, "pointer");
      waitForSettle();
    },
  };
};
