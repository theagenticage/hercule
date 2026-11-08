/**
 * How a card in the hand leaves its place in the page. The card stays mounted
 * and is hidden with `data-dragged` (see `drag.css`), because React must be
 * able to keep it. A card that stands in a stack is one of two kinds:
 *
 * - A member stands in the members of a stack. Hiding it is enough: the stack
 *   keeps its lead and its other members.
 * - The lead stands in its stack. Carried alone, it leaves the stack without a
 *   card to hang from, so the whole stack is hidden with it. Its members stand
 *   alone again once the drop is drawn.
 *
 * This file also holds every lookup of the stack's parts in the page. A stack
 * is an element with `data-stack-lead`, the id of its lead card, so no other
 * file has to know the order of the elements inside it.
 */

/** Returns the stack that `element` stands in (as its lead, sheet or member), or `null` for a card alone. */
export const findStack = (element: Element): HTMLElement | null =>
  element.closest<HTMLElement>("[data-stack-lead]");

/** Returns the lead card of `stack`, or `null` when the page does not draw it. */
export const findStackLead = (stack: HTMLElement): HTMLElement | null =>
  stack.querySelector<HTMLElement>(
    `:scope > [data-card-id="${CSS.escape(stack.dataset["stackLead"] ?? "")}"]`,
  );

/** Returns the element that holds the member cards of `stack`, or `null` when the stack is closed. */
export const findStackMembers = (stack: HTMLElement): HTMLElement | null =>
  stack.querySelector<HTMLElement>(":scope > .board-stack-members");

/** Returns the stack that `card` leads, or `null` when it is a card alone or a member. */
const findStackLedBy = (card: HTMLElement): HTMLElement | null => {
  const stack = findStack(card);
  return stack !== null && findStackLead(stack) === card ? stack : null;
};

/**
 * Returns the child of its cell that stands for `card`: the stack the card is
 * in, or the card itself when it is in none. The slot of a carried card opens
 * before it.
 */
export const findCellRow = (card: HTMLElement): HTMLElement => findStack(card) ?? card;

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
