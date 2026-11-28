/**
 * Returns whether the reader asked for no movement, through the system's
 * Reduce motion setting. The stylesheet sets the duration tokens to `0s` for
 * CSS, so this reads the same token (`--dur-2`). A page with no stylesheet,
 * as in a test, counts as reduced unless the test sets the token. The app's
 * own Reduce motion setting will count too, once it zeroes the tokens.
 */
export const isMotionReduced = (): boolean => {
  const duration = getComputedStyle(document.documentElement).getPropertyValue("--dur-2");
  return !(Number.parseFloat(duration) > 0);
};
