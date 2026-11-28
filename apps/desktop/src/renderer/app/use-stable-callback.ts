import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Returns a function that never changes identity and calls the newest
 * `callback` that was committed.
 *
 * A screen's callbacks close over its state, so they are new on every render.
 * Handed down as they are, they make a memoized child draw again for a render
 * that changed nothing the child shows. The stable function does not.
 *
 * Call the result from event handlers only: it runs the callback of the last
 * commit, not the one of a render still in progress.
 */
export const useStableCallback = <Args extends readonly unknown[], Result>(
  callback: (...args: Args) => Result,
): ((...args: Args) => Result) => {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
};
