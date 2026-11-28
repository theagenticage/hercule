/**
 * The page's default ease out, the stylesheet's `--m-ease`. A Web Animation
 * cannot read a custom property, so its easing is written here, and
 * `ease.test.ts` checks that it equals the token.
 */
export const MOTION_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
