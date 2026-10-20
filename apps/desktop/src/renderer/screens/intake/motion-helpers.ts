/**
 * Small helpers the motion of Intake's lists and of Tracking share: where
 * things are on screen, whether motion plays, and copies of elements to move.
 */
import { readMotionDuration } from "./motion-tokens";

/** The top and bottom edges of a row or of a list's viewport, in pixels from the window's top. */
export interface RowPlace {
  readonly top: number;
  readonly bottom: number;
}

/** Checks whether any part of `place` shows inside `viewport`. */
export const isOnScreen = (place: RowPlace, viewport: RowPlace): boolean =>
  place.bottom > viewport.top && place.top < viewport.bottom;

/**
 * Checks whether a motion would play: `--dur-2` is more than 0, which Reduce
 * motion and a page with no stylesheet make it, and someone can see the window.
 */
export const isMotionShown = (): boolean => !document.hidden && readMotionDuration("--dur-2") > 0;

/**
 * Returns a copy of `element` to animate where it was, such as a row that
 * leaves. The copy keeps the element's look, but loses every `id` and `data-*`
 * attribute, so neither the page's ids nor a query for its data ever finds it.
 */
export const copyElementWithoutIds = (element: HTMLElement): HTMLElement => {
  const copy = element.cloneNode(true) as HTMLElement;
  for (const each of [copy, ...copy.querySelectorAll<HTMLElement>("*")]) {
    for (const name of each.getAttributeNames()) {
      if (name === "id" || name.startsWith("data-")) each.removeAttribute(name);
    }
  }
  return copy;
};
