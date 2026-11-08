import { waitForStillHand, type StillHandOptions } from "../../app/motion";
import { isWindowVisible, waitForVisibleWindow } from "../../app/window-visibility";

/**
 * Waits for a still hand (`waitForStillHand`) for as long as the window can be
 * seen, and resolves with `true` only while it can: a change that plays when
 * this resolves never plays in a hidden window. When the window hides, the
 * wait stops and its polling with it; when the window shows again, the wait
 * starts over, with its time limit. Resolves with `false` when `options.signal`
 * aborts.
 *
 * It does not wait a tick when the window is visible and the hand is still, so
 * a caller can act in the same task.
 */
export const waitForVisibleStillHand = async (options: StillHandOptions): Promise<boolean> => {
  const { signal } = options;
  for (;;) {
    if (
      !isWindowVisible() &&
      !(await waitForVisibleWindow(signal ?? new AbortController().signal))
    ) {
      return false;
    }
    const hidden = new AbortController();
    const stop = (): void => {
      hidden.abort();
    };
    const stopWhenHidden = (): void => {
      if (!isWindowVisible()) hidden.abort();
    };
    document.addEventListener("visibilitychange", stopWhenHidden);
    signal?.addEventListener("abort", stop, { once: true });
    const isStill = await waitForStillHand({ ...options, signal: hidden.signal });
    document.removeEventListener("visibilitychange", stopWhenHidden);
    signal?.removeEventListener("abort", stop);
    if (signal?.aborted === true) return false;
    if (isStill && isWindowVisible()) return true;
  }
};
