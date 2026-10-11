/**
 * Tells a row whether it is inside the visible part of its list, so a label
 * in the row that counts time registers with the age clock only while it can
 * be seen (spec 17 §Performance, "No polling, and no timers while idle").
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * Starts reporting whether `element` is inside the visible part of the
 * scroller: `onChange(true)` when it comes into view, and `onChange(false)`
 * when it leaves. Returns the function that stops the reports.
 */
export type ScreenWatcher = (element: Element, onChange: (onScreen: boolean) => void) => () => void;

/**
 * Returns a `ScreenWatcher` for the elements inside the scroller `scrollerRef`
 * points at. All elements share one IntersectionObserver, created on the
 * first watch and disconnected when the calling component unmounts.
 *
 * Without `scrollerRef`, the observer watches the window. An element scrolled
 * out of any scroller it sits in still counts as off screen then, because
 * the browser clips what is visible by every scroller between the element
 * and the window.
 */
export const useScreenWatcher = (scrollerRef?: RefObject<HTMLElement | null>): ScreenWatcher => {
  const watchedRef = useRef<{
    readonly observer: IntersectionObserver;
    readonly callbacks: Map<Element, (onScreen: boolean) => void>;
  } | null>(null);
  useEffect(
    () => () => {
      watchedRef.current?.observer.disconnect();
      watchedRef.current = null;
    },
    [],
  );
  return useCallback(
    (element, onChange) => {
      if (watchedRef.current === null) {
        const callbacks = new Map<Element, (onScreen: boolean) => void>();
        const observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting);
          },
          { root: scrollerRef?.current ?? null },
        );
        watchedRef.current = { observer, callbacks };
      }
      const { observer, callbacks } = watchedRef.current;
      callbacks.set(element, onChange);
      observer.observe(element);
      return () => {
        callbacks.delete(element);
        observer.unobserve(element);
      };
    },
    [scrollerRef],
  );
};

/**
 * Returns whether the element `elementRef` points at is inside the visible
 * part of its scroller, as `watchScreen` reports it. The element is watched
 * only while `watching` is true; otherwise, and until the first report,
 * which comes as soon as the element is watched, the answer is false.
 */
export const useIsOnScreen = (
  watchScreen: ScreenWatcher,
  elementRef: RefObject<Element | null>,
  watching: boolean,
): boolean => {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(
    () => (watching ? watchScreen(elementRef.current!, setOnScreen) : undefined),
    [watching, watchScreen, elementRef],
  );
  return onScreen;
};
