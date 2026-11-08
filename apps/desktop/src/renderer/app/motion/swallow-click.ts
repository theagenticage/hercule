/** How long, in milliseconds, a click right after a carry is swallowed. */
const CLICK_GUARD_MS = 50;

/**
 * Swallows the click that follows a carry, which would otherwise open the card
 * that was dropped. `isPointerUp` is whether the button is already up. When
 * it is not (Esc was pressed with the button held), the click comes when the
 * user lets go, so the guard waits for that. A new press ends the guard, so a
 * release that never arrives cannot swallow a later click.
 */
export const swallowNextClick = (isPointerUp: boolean): void => {
  // The guard can outlive the page that made it, such as a test environment that is torn down within the 50 ms.
  // It keeps the window it started on, so ending the guard never reads a global that is gone.
  const target = window;
  let timer: number | undefined;
  const stop = (event: Event): void => {
    event.stopPropagation();
    event.preventDefault();
    clear();
  };
  const startTimer = (): void => {
    timer = target.setTimeout(clear, CLICK_GUARD_MS);
  };
  function clear(): void {
    target.removeEventListener("click", stop, true);
    target.removeEventListener("pointerup", startTimer, true);
    target.removeEventListener("pointerdown", clear, true);
    target.clearTimeout(timer);
  }
  target.addEventListener("click", stop, true);
  target.addEventListener("pointerdown", clear, true);
  if (isPointerUp) startTimer();
  else target.addEventListener("pointerup", startTimer, { capture: true, once: true });
};
