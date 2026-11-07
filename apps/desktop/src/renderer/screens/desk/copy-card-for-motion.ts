import { copyElementWithoutIds } from "../../app/motion";

/** The `data-*` attributes the stylesheet draws a card by. A copy keeps them, or it would not look like the card. */
const LOOK_ATTRIBUTES = ["data-state", "data-now", "data-pose", "data-still"];

/** The classes a card wears for a moment, such as while it moves or has focus. A copy does not share them. */
const MOMENT_CLASSES = ["is-focus", "is-moving", "is-rising", "is-carried"];

/**
 * Returns a copy of `card`, the element of a `Card`, to move or to show where
 * the card was: it looks like the card but is not one. It has no `id`, no
 * `data-card-id` or other `data-*` that is not part of the card's look, no
 * role, label or tab stop, no inline style, and none of the classes the card
 * wears for a moment. It is hidden from assistive technology and cannot be
 * clicked or focused.
 *
 * A copy that kept the card's `data-card-id` would be found by every lookup
 * of that card while it is in flight.
 */
export const copyCardForMotion = (card: HTMLElement): HTMLElement => {
  const copy = copyElementWithoutIds(card, LOOK_ATTRIBUTES);
  for (const name of ["tabindex", "role", "aria-label"]) copy.removeAttribute(name);
  copy.classList.remove(...MOMENT_CLASSES);
  copy.removeAttribute("style");
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  return copy;
};
