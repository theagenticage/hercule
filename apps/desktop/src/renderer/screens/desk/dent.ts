import { measureLayoutRect } from "../../app/motion";

/** The class of the dent. The stylesheet in `card.css` draws it. */
const DENT_CLASS = "desk-dent";

/**
 * Puts a dent where `card` stands: a faint hollow of the card's height, placed
 * just before it, in the same list. When the card then leaves, the dent keeps
 * its place open, so what the user was looking at below it does not jump.
 * Call it before the change that removes the card. Returns the dent. The
 * caller removes it (`dent.remove()`) when the place may close, ideally inside
 * a FLIP so the cards below glide up.
 */
export const openDent = (card: HTMLElement): HTMLElement => {
  const dent = document.createElement("div");
  dent.className = DENT_CLASS;
  dent.setAttribute("aria-hidden", "true");
  dent.style.height = `${String(measureLayoutRect(card).height)}px`;
  card.before(dent);
  return dent;
};
