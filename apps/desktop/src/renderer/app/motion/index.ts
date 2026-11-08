/**
 * The motion kernel: springs, one animation clock, and the helpers that move
 * elements on them. Everything is interruptible, because every change starts
 * from what is on screen with the speed it has. Only `transform`, `opacity`
 * and the `--lift` custom property are written; `will-change` is set only
 * while a body moves, by the `is-moving` class; and the clock asks for a frame
 * only while something moves. `buildSpringCurve` and `buildSpringKnock` are the
 * other way to use a spring: as the easing or the keyframes of a Web Animation,
 * and `knockElement` plays the keyframes as a push. `flyToSidebarTarget` and
 * `flyHomeFromSidebarTarget` fly a mark between a screen and the sidebar.
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
export { MOTION_EASE } from "./ease";
export { knockElement } from "./knock";
export {
  flyHomeFromSidebarTarget,
  flyToSidebarTarget,
  type SidebarFlight,
  type SidebarTargetName,
} from "./sidebar-flight";
export { HAND_STILL_AFTER_MS, HandTracker } from "./hand";
export { trackCarryGesture, type CarryGesture } from "./carry-gesture";
export { swallowNextClick } from "./swallow-click";
export { copyElementWithoutIds } from "./copy-element";
export { isMotionReduced } from "./reduced";
export {
  buildSpringCurve,
  buildSpringKnock,
  type SpringCurve,
  type SpringKnock,
} from "./spring-curve";
export type { SpringName } from "./springs";
export { animateValue, type MotionValue } from "./value";
export { pauseFor } from "./pause";
export { waitForStillHand, type StillHandOptions } from "./still-hand";
