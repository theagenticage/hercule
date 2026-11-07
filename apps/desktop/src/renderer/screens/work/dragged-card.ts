/**
 * How a card in the hand leaves its place in the page. The card stays mounted
 * and is hidden with `data-dragged` (see `drag.css`), because React must be
 * able to keep it. A card that stands in a stack is one of two kinds:
 *
 * - A member stands in `.board-stack-members`. Hiding it is enough: the stack
 *   keeps its lead and its other members.
 * - The lead stands first in `.board-stack`. Carried alone, it leaves the
 *   stack without a card to hang from, so the whole stack is hidden with it.
 *   Its members stand alone again once the drop is drawn.
 */

/** Returns the stack that `card` leads, or `null` when it is a card alone or a member. */
const findStackLedBy = (card: HTMLElement): HTMLElement | null => {
  const stack = card.parentElement;
  return stack?.classList.contains("board-stack") === true ? stack : null;
};

/**
 * Returns the child of its cell that stands for `card`: the stack the card is
 * in, or the card itself when it is in none. The slot of a carried card opens
 * before it.
 */
export const findCellRow = (card: HTMLElement): HTMLElement =>
  card.closest<HTMLElement>(".board-stack") ?? card;

/** Hides `card` for as long as it is in the hand, and its stack too when it leads one. */
export const hideDraggedCard = (card: HTMLElement): void => {
  card.dataset["dragged"] = "";
  findStackLedBy(card)?.setAttribute("data-dragged", "");
};

/** Shows `card` again, and the stack it leads, once it has left the hand. */
export const showDraggedCard = (card: HTMLElement): void => {
  delete card.dataset["dragged"];
  findStackLedBy(card)?.removeAttribute("data-dragged");
};
