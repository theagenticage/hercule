/**
 * Small helpers the motion of Intake's lists and of Tracking share: where
 * things are on screen and whether motion plays.
 */
import { isMotionReduced } from "../../app/motion";

/** The top and bottom edges of a row or of a list's viewport, in pixels from the window's top. */
export interface RowPlace {
  readonly top: number;
  readonly bottom: number;
}

/** Checks whether any part of `place` shows inside `viewport`. */
export const isOnScreen = (place: RowPlace, viewport: RowPlace): boolean =>
  place.bottom > viewport.top && place.top < viewport.bottom;

/**
 * Checks whether a motion would play: motion is not reduced (Reduce motion, or
 * a page with no stylesheet, as in tests, reduces it) and someone can see the window.
 */
export const isMotionShown = (): boolean => !document.hidden && !isMotionReduced();
