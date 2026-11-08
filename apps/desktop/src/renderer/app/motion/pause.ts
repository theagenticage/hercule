/**
 * Waits `milliseconds`. Resolves with `true` when the time has passed, and
 * with `false` when `signal` aborts first, so a caller that was cancelled does
 * not go on. Resolves at once, without a timer, when there is nothing to wait
 * for.
 */
export const pauseFor = (milliseconds: number, signal: AbortSignal): Promise<boolean> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    if (milliseconds <= 0) {
      resolve(true);
      return;
    }
    const stop = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve(true);
    }, milliseconds);
    signal.addEventListener("abort", stop, { once: true });
  });
