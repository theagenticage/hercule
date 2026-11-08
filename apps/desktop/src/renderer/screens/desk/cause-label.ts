import { trackBody } from "../../app/motion";

/** The class of the label. The stylesheet in `card.css` draws it. */
const CAUSE_CLASS = "card-cause";

/**
 * Puts a small label on each of `cards` that says why the card is about to
 * move, such as "PR #6221 merged". It sits at the bottom left, where the
 * card's age usually is, and the card hides its age and marks while the label
 * is on (`data-cause`, which React never rewrites).
 *
 * With `rises`, the label rises 6px into place and fades in on `hand`, so the
 * cause lands on the card before the card moves. Under Reduce motion it only
 * fades in. Without it, the label is simply there: use that for a card that
 * has just been drawn again in its new place.
 *
 * Returns the function that takes the labels away again. It can be called
 * more than once.
 */
export const showCauseLabel = (
  cards: readonly HTMLElement[],
  text: string,
  rises: boolean,
): (() => void) => {
  const labels = cards.map((card) => {
    const label = document.createElement("span");
    label.className = CAUSE_CLASS;
    label.textContent = text;
    label.setAttribute("aria-hidden", "true");
    card.append(label);
    card.dataset["cause"] = "";
    if (rises) {
      const body = trackBody(label);
      body.set({ y: 6, o: 0 });
      body.to({ y: 0, o: 1 }, "hand");
    }
    return { card, label };
  });
  return () => {
    for (const { card, label } of labels) {
      label.remove();
      delete card.dataset["cause"];
    }
  };
};
