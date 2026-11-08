import { trackBody } from "../../app/motion";

/** The class of the label. The stylesheet in `card.css` draws it. */
const CAUSE_CLASS = "card-cause";

/** The labels `showCauseLabel` put on cards. */
export interface CauseLabels {
  /**
   * Puts the labels on `cards` in place of the cards they were on, the first
   * label on the first card and so on, in page order. A label with no card
   * left is taken away. Use it when React drew the card again as a new element,
   * which it does when a card changes cell: the label is the same element, so
   * the cause is shown once.
   */
  readonly moveTo: (cards: readonly HTMLElement[]) => void;
  /** Takes the labels away. It can be called more than once. */
  readonly remove: () => void;
}

/**
 * Puts a small label on each of `cards` that says why the card is about to
 * move, such as "Pull request #6221 merged". It sits at the bottom left, where
 * the card's age usually is, and the card hides its age and marks while the
 * label is on (`data-cause`, which React never rewrites).
 *
 * The label rises 6px into place and fades in on `hand`, so the cause lands on
 * the card before the card moves. Under Reduce motion it only fades in.
 */
export const showCauseLabel = (cards: readonly HTMLElement[], text: string): CauseLabels => {
  let placed = cards.map((card) => {
    const label = document.createElement("span");
    label.className = CAUSE_CLASS;
    label.textContent = text;
    label.setAttribute("aria-hidden", "true");
    card.append(label);
    card.dataset["cause"] = "";
    const body = trackBody(label);
    body.set({ y: 6, o: 0 });
    body.to({ y: 0, o: 1 }, "hand");
    return { card, label };
  });
  const take = ({ card, label }: { card: HTMLElement; label: HTMLElement }): void => {
    label.remove();
    delete card.dataset["cause"];
  };
  return {
    moveTo: (nextCards) => {
      placed = placed.flatMap((each, index) => {
        const card = nextCards[index];
        if (card === undefined) {
          take(each);
          return [];
        }
        delete each.card.dataset["cause"];
        card.append(each.label);
        card.dataset["cause"] = "";
        return [{ card, label: each.label }];
      });
    },
    remove: () => {
      placed.forEach(take);
      placed = [];
    },
  };
};
