import { buildSpringKnock } from "./spring-curve";

/**
 * Gives `element` one knock: it is pushed down at `speed` pixels a second
 * (up for a negative speed), and the `hand` spring brings it back. Returns
 * the animation, so a caller can cancel it. The animation adds to the
 * element's own transform, so an element that is also moving on a body is
 * not disturbed, and it runs on the compositor.
 *
 * `delay` is the milliseconds to wait before the push. Does not look at
 * Reduce motion: a caller that must stand still under it does not call this.
 */
export const knockElement = (element: Element, speed: number, delay = 0): Animation => {
  const { offsets, ms } = buildSpringKnock("hand", speed);
  return element.animate(
    offsets.map((offset) => ({ transform: `translate3d(0,${offset.toFixed(2)}px,0)` })),
    { duration: ms, delay, easing: "linear", composite: "add" },
  );
};
