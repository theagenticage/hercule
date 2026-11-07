/**
 * Checks whether the reader asked for no movement, through the system's
 * Reduce motion. The stylesheet answers it for CSS by setting the duration
 * tokens to `0s`, so the same token answers it here, and a page with no
 * stylesheet, as in a test, counts as reduced unless the test sets the token.
 * The app's own Reduce motion setting will count too, the day it zeroes the
 * tokens.
 */
export const isMotionReduced = (): boolean => {
  const duration = getComputedStyle(document.documentElement).getPropertyValue("--dur-2");
  return !(Number.parseFloat(duration) > 0);
};
