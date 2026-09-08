/**
 * Keeps the thread's own scroll position pinned to the tail while the reader
 * is already there, and leaves it alone the moment they scroll up to read
 * back - the one rule a chat-shaped column follows. The thread has no scroll
 * region of its own; the whole page does, so the scroll container is the
 * document's own scrolling element.
 *
 * `atBottomRef` is the one piece of state this needs. It is read, never
 * derived fresh, by `followIfAtBottom`: by the time anything calls it, the
 * transcript has already grown to include whatever just arrived, so the
 * geometry in hand can only answer "is the reader at the tail now that it
 * grew" - not "were they, a moment before." It is kept current instead by
 * the container's own `scroll` event, and by `scrollToBottom` itself.
 */
import { useCallback, useEffect, useRef } from "react";

/** About one line of text: a reader a few pixels short of the tail still reads as "there." */
const NEAR_BOTTOM_PX = 24;

export interface StickToBottom {
  /** Call after anything that may have grown the transcript's content. */
  readonly followIfAtBottom: () => void;
  /** Unconditional: sending a message always rejoins the tail. */
  readonly scrollToBottom: () => void;
}

export const useStickToBottom = (): StickToBottom => {
  const elementRef = useRef<Element | null>(null);
  const atBottomRef = useRef(true);

  useEffect(() => {
    const element = document.scrollingElement ?? document.documentElement;
    elementRef.current = element;

    const onScroll = (): void => {
      atBottomRef.current =
        element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_BOTTOM_PX;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const scrollToBottom = useCallback(() => {
    const element = elementRef.current;
    if (element === null) return;
    // `scrollHeight` alone overshoots by one viewport: a real browser clamps
    // that back down for a plain scrollTop assignment, but the tail is
    // `scrollHeight - clientHeight`, exactly, and nothing here should depend
    // on a browser doing the clamping for it.
    element.scrollTop = element.scrollHeight - element.clientHeight;
    atBottomRef.current = true;
  }, []);

  const followIfAtBottom = useCallback(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [scrollToBottom]);

  return { followIfAtBottom, scrollToBottom };
};
