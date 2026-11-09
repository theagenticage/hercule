/** How long, in milliseconds, a click right after a carry is swallowed. */
const CLICK_GUARD_MS = 50;

/**
 * Swallows the click that follows a carry, which would otherwise open the card
 * that was dropped. `isPointerUp` is whether the button is already up. When
 * it is not (Esc was pressed with the button held), the click comes when the
 * user lets go, so the guard counts its 50 ms from that release. A new press
 * ends the guard, so a release that never arrives cannot swallow a later click.
 *
 * The guard keeps no timer. It stays on the window until the next click or
 * press, and a click that comes after the 50 ms passes through and ends it. A
 * timer would fire in whatever page is left when it runs, and in a test
 * environment that is torn down within the 50 ms the window's methods are gone
 * by then, so the timer would throw.
 */
export const swallowNextClick = (isPointerUp: boolean): void => {
  let guardEndsAt = isPointerUp ? performance.now() + CLICK_GUARD_MS : Number.POSITIVE_INFINITY;
  const endGuard = (): void => {
    window.removeEventListener("click", swallow, true);
    window.removeEventListener("pointerup", startCountdown, true);
    window.removeEventListener("pointerdown", endGuard, true);
  };
  const swallow = (event: Event): void => {
    endGuard();
    // Later than the guard: this click is the user's own.
    if (performance.now() >= guardEndsAt) return;
    event.stopPropagation();
    event.preventDefault();
  };
  const startCountdown = (): void => {
    guardEndsAt = performance.now() + CLICK_GUARD_MS;
  };
  window.addEventListener("click", swallow, true);
  window.addEventListener("pointerdown", endGuard, true);
  if (!isPointerUp)
    window.addEventListener("pointerup", startCountdown, { capture: true, once: true });
};
