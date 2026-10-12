/**
 * Reads the motion tokens, `--dur-1` to `--dur-3` and `--ease-out`, as the
 * page's stylesheet sets them, for motion that runs from code rather than
 * from CSS.
 */

/** One of the design language's three durations. */
export type MotionDuration = "--dur-1" | "--dur-2" | "--dur-3";

/** Returns the value of the custom property `name` on the page's root, trimmed. */
const readRootProperty = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Returns the duration `token` in milliseconds, as the page's stylesheet sets
 * it. It is 0 under Reduce motion, which zeroes the durations, and 0 when no
 * stylesheet sets it, as in tests. A caller treats 0 as "no motion".
 */
export const readMotionDuration = (token: MotionDuration): number => {
  const value = readRootProperty(token);
  const amount = Number.parseFloat(value);
  if (Number.isNaN(amount)) return 0;
  return value.endsWith("ms") ? amount : amount * 1000;
};

/** Returns `--ease-out` for an animation started from code, or the browser's `ease-out` when no stylesheet sets it. */
export const readMotionEasing = (): string => readRootProperty("--ease-out") || "ease-out";
