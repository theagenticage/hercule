import type { CardInLane } from "@hercule/client-core/work";

/**
 * Finding a card on the page. A Task under two outside places has a card in
 * each lane, so the card's id alone does not name one element: the lane is
 * part of the name. Cells and lanes carry `data-lane-id`, and cards carry
 * `data-card-id`.
 */

/** Returns the element of the card `at` under `root`, or `null` when its lane does not show it. */
export const findCardElement = (root: ParentNode, at: CardInLane): HTMLElement | null =>
  root.querySelector<HTMLElement>(
    `[data-lane-id="${CSS.escape(at.laneId)}"] [data-card-id="${CSS.escape(at.cardId)}"]`,
  );

/** Returns which card of which lane `element` is, or `null` when it is not a card on a lane. */
export const readCardInLane = (element: Element): CardInLane | null => {
  const card = element.closest<HTMLElement>("[data-card-id]");
  const cardId = card?.dataset["cardId"];
  const laneId = card?.closest<HTMLElement>("[data-lane-id]")?.dataset["laneId"];
  return cardId === undefined || laneId === undefined ? null : { laneId, cardId };
};

/** Returns whether `a` and `b` are the same card in the same lane. A missing one is never the same. */
export const isSameCardInLane = (a: CardInLane | null, b: CardInLane | null): boolean =>
  a !== null && b !== null && a.laneId === b.laneId && a.cardId === b.cardId;
