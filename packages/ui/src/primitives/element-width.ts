import { useLayoutEffect, useState } from "react";

/**
 * Measures an element's width, and measures it again whenever it changes.
 * Returns a callback to pass as the element's `ref`, and the element's width
 * in pixels, which is `undefined` until the element is measured. Pass the
 * callback as `ref` only while the width is needed: an element that is never
 * passed is never observed.
 *
 * The first measurement is taken before the browser paints, so no frame shows
 * a layout computed without it. A width of 0 is not a measurement: jsdom lays
 * nothing out, so an element there stays unmeasured.
 */
export function useElementWidth(): {
  readonly observeElement: (element: HTMLElement | null) => void;
  readonly width: number | undefined;
} {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (element === null) return;
    const measure = (measured: number): void => {
      if (measured > 0) setWidth(measured);
    };
    measure(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) measure(entry.contentRect.width);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [element]);
  return { observeElement: setElement, width };
}
