/**
 * The motion kernel: springs, one animation clock, and the helpers that move
 * elements on them. Everything is interruptible, because every change starts
 * from what is on screen with the speed it has. Only `transform`, `opacity`
 * and the `--lift` custom property are written; `will-change` is set only
 * while a body moves, by the `is-moving` class; and the clock asks for a frame
 * only while something moves. `buildSpringCurve` is the other way to use a
 * spring: as the easing of a Web Animation.
 */
export { findBody, MOVING_CLASS, trackBody, type MotionBody, type Velocity } from "./body";
export {
  computeCenter,
  ensureOverlayLayer,
  flipByKey,
  ghostElement,
  measureLayoutRect,
  staggerDelay,
  type FlipByKeyResult,
  type FlipByKeyOptions,
  type LayoutRect,
} from "./layout";
export { copyElementWithoutIds } from "./copy-element";
export { isMotionReduced } from "./reduced";
export { buildSpringCurve, type SpringCurve } from "./spring-curve";
export type { SpringName } from "./springs";
export { animateValue, type MotionValue } from "./value";
export { waitForStillHand } from "./still-hand";
