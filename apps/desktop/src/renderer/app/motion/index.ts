/**
 * The motion kernel: springs, one animation clock, and the helpers that move
 * elements on them. Everything is interruptible, because every change starts
 * from what is on screen with the speed it has. Only `transform`, `opacity`
 * and the `--lift` custom property are written; `will-change` is set only
 * while a body moves, by the `is-moving` class; and the clock asks for a frame
 * only while something moves.
 */
export {
  findBody,
  trackBody,
  MotionBody,
  RISING_CLASS,
  type MoveOptions,
  type Velocity,
} from "./body";
export {
  flipByKey,
  flipElements,
  ghostElement,
  measureLayoutRect,
  staggerDelay,
  LONGEST_STAGGER,
  type FlipByKeyOptions,
  type FlipOptions,
  type LayoutRect,
} from "./layout";
export { isMotionReduced } from "./reduced";
export {
  SPRINGS,
  type Channel,
  type ChannelValues,
  type PartialChannelValues,
  type Spring,
  type SpringName,
} from "./springs";
export { animateValue, type MotionValue } from "./value";
export { waitForStillHand, type StillHandOptions } from "./still-hand";
