/**
 * The two checks a workflow screen makes around the motion that shows a
 * change (spec 17, "Workflows' motion").
 *
 * A row or the lanes record a change only while Reduce motion is off. Once
 * no animation is left playing, they drop the classes that started the
 * motion. A class left in place would play its animation again whenever
 * React moves the element in the page, or the user turns Reduce motion off,
 * because Chromium starts a CSS animation afresh in both cases.
 */

/** Checks whether the user has turned Reduce motion on. */
export const isMotionReduced = (): boolean =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Checks whether a CSS animation is still playing on `element` or inside it,
 * or still waiting out its delay. Transitions do not count, so a hover's
 * fade does not keep a change's motion from ending.
 */
export const isAnimationPlaying = (element: Element): boolean =>
  element.getAnimations({ subtree: true }).some((animation) => animation instanceof CSSAnimation);
