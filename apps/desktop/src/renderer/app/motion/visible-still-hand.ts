import { isWindowVisible, waitForVisibleWindow } from "../window-visibility";
import { waitForStillHand, type StillHandOptions } from "./still-hand";

/**
 * Waits for a still hand (`waitForStillHand`) for as long as the window can be
 * seen, and resolves with `true` only while it can: a change that plays when
 * this resolves never plays in a hidden window. When the window hides, the
 * wait stops and its polling with it; when the window shows again, the wait
 * starts over, with its time limit. Resolves with `false` when `options.signal`
 * aborts, and at once, starting nothing, when it has already aborted. Every
 * wait inside is tied to that signal, so an aborted caller leaves no timer and
 * no listener behind.
 *
 * It does not wait a tick when the window is visible and the hand is still, so
 * a caller can act in the same task.
 */
export const waitForVisibleStillHand = async (options: StillHandOptions): Promise<boolean> => {
  const { signal } = options;
  // A function, not a value: the signal can abort while the wait is under way.
  const isAborted = (): boolean => signal?.aborted === true;
  for (;;) {
    if (isAborted()) return false;
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
    if (isAborted()) return false;
    if (isStill && isWindowVisible()) return true;
  }
};
