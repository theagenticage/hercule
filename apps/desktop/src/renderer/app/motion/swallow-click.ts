/** How long, in milliseconds, a click right after a carry is swallowed. */
const CLICK_GUARD_MS = 50;

/**
 * Swallows the click that follows a carry, which would otherwise open the card
 * that was dropped. `isPointerUp` is whether the button is already up. When
 * it is not (Esc was pressed with the button held), the click comes when the
 * user lets go, so the guard waits for that. A new press ends the guard, so a
 * release that never arrives cannot swallow a later click.
 *
 * The guard ends on a timer, 50 ms after the drop or the release. A timer
 * cannot fire until the handler that started it has returned, however long
 * that takes, so the click the browser sends right after the handler is always
 * swallowed. A clock reading would let that click through after a slow handler.
 *
 * The timer can fire after the page that made it is gone, such as in a test
 * environment that is torn down within the 50 ms, where the window's methods
 * no longer exist. So ending the guard uses only what this call took when it
 * started: an `AbortController` removes the listeners, and `clearTimeout` was
 * read here, so no global is read when the timer fires.
 */
export const swallowNextClick = (isPointerUp: boolean): void => {
  const listeners = new AbortController();
  const { signal } = listeners;
  const cancelTimer = clearTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => {
    listeners.abort();
    cancelTimer(timer);
  };
  const stop = (event: Event): void => {
    event.stopPropagation();
    event.preventDefault();
    clear();
  };
  const startTimer = (): void => {
    timer = setTimeout(clear, CLICK_GUARD_MS);
  };
  window.addEventListener("click", stop, { capture: true, signal });
  window.addEventListener("pointerdown", clear, { capture: true, signal });
  if (isPointerUp) startTimer();
  else window.addEventListener("pointerup", startTimer, { capture: true, once: true, signal });
};
