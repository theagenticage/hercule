/**
 * Reading the Inbox page from the DOM: which cards stand on it, in which
 * order, and which card an element belongs to. Keys, the pointer and motion
 * all start from here, so the page is described in one place.
 */
import type { InboxStop } from "@hercule/client-core/inbox";
import type { OpenTarget } from "./use-open-card";

/** Matches the element of a card that has moves: a row of lasting work or a request. Pointers ("Also in ...") are not cards. */
export const CARD_SELECTOR = ".inbox-row[data-card-id], .inbox-request[data-card-id]";

/** Returns the element of the card `id` under `root`, or `null` when the page does not show it. */
export const findCardElement = (root: ParentNode, id: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`);

/**
 * Returns the element on the page that stands for `target`, searched in the
 * desk `near` lies in (else in the whole document), or `null` when none is
 * drawn. A card is found by its id and a place by its ref, never one for the
 * other.
 */
export const findCardOrPlaceElement = (
  target: OpenTarget,
  near: HTMLElement | null,
): HTMLElement | null => {
  const desk = near?.closest(".inbox-desk") ?? document;
  const selector =
    target.kind === "card"
      ? `[data-card-id="${CSS.escape(target.id)}"]`
      : `[data-place-ref="${CSS.escape(target.ref)}"]`;
  return desk.querySelector<HTMLElement>(selector);
};

/** Returns the card element `element` is, or is inside of, or `null`. */
export const readCardElement = (element: Element | null): HTMLElement | null =>
  element?.closest<HTMLElement>(CARD_SELECTOR) ?? null;

/** Returns the id of the card `element` is, or is inside of, or `null`. */
export const readCardId = (element: Element | null): string | null =>
  readCardElement(element)?.dataset["cardId"] ?? null;

/**
 * Returns every card on the page as a stop, in the order the page draws them:
 * the wide side first, then the narrow column. A card with a live Task carries
 * `data-has-task` and no longer waits for the user.
 */
export const readInboxStops = (root: ParentNode): readonly InboxStop[] =>
  Array.from(root.querySelectorAll<HTMLElement>(CARD_SELECTOR), (element) => {
    const rect = element.getBoundingClientRect();
    return {
      id: element.dataset["cardId"] ?? "",
      column: element.closest(".inbox-narrow") === null ? "wide" : "narrow",
      middle: rect.top + rect.height / 2,
      waits: !element.hasAttribute("data-has-task"),
    };
  });
