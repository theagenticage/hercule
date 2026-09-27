/**
 * Keeps a thread or an assistant's conversation scrolled to the bottom while the user
 * is already there, and stops following as soon as they scroll up to read
 * back. Neither screen has a scroll region of its own: they scroll with the
 * shell's `main` element, the one element inside the shell that scrolls.
 *
 * The only state is `atBottomRef`. `followIfAtBottom` reads it rather than
 * measuring the page, because by the time it is called the column has
 * already grown. A fresh measurement could only tell whether the user is at
 * the bottom after the growth, not whether they were just before it. So the
 * ref is updated instead by the scroll container's `scroll` event and by
 * `scrollToBottom`.
 *
 * The scrolling element is looked up on every call rather than kept in a ref.
 * A screen scrolls to the bottom from its mount `useLayoutEffect`, which runs
 * before any `useEffect` of this hook could have stored it.
 *
 * The router scrolls `main` back to the top after every navigation has
 * rendered, so that a new screen opens at its top. That reset runs after the
 * screen's own effects, and it would leave a thread or a conversation showing
 * its oldest message. So the hook scrolls to the bottom again right after the
 * reset: for these two screens, the bottom is where a screen opens.
 */
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";

/** About one line of text: a user a few pixels above the bottom still counts as at the bottom. */
const NEAR_BOTTOM_PX = 24;

export interface StickToBottom {
  /** Scrolls to the bottom if the user was there. Call it after the column may have grown. */
  readonly followIfAtBottom: () => void;
  /** Always scrolls to the bottom; used when the user sends a message. */
  readonly scrollToBottom: () => void;
}

/**
 * Returns the element that scrolls the screen: the shell's `main`, or the
 * document's root element if no `main` is mounted.
 */
export const findScrollingElement = (): Element =>
  document.querySelector("main") ?? document.documentElement;

export const useStickToBottom = (): StickToBottom => {
  const router = useRouter();
  const atBottomRef = useRef(true);

  useEffect(() => {
    const element = findScrollingElement();
    const onScroll = (): void => {
      atBottomRef.current =
        element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_BOTTOM_PX;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  const scrollToBottom = useCallback(() => {
    const element = findScrollingElement();
    // `scrollHeight` alone overshoots by one viewport height. A real browser
    // clamps the value, but the exact bottom is `scrollHeight - clientHeight`,
    // and this code should not rely on the browser clamping it.
    element.scrollTop = element.scrollHeight - element.clientHeight;
    atBottomRef.current = true;
  }, []);

  // The router's own `onRendered` listener, the one that resets `main`, was
  // added when the router was created, so it always runs before this one.
  useEffect(() => router.subscribe("onRendered", scrollToBottom), [router, scrollToBottom]);

  const followIfAtBottom = useCallback(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [scrollToBottom]);

  return { followIfAtBottom, scrollToBottom };
};
