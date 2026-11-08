/**
 * Reading the Inbox page from the DOM: which cards stand on it, in which
 * order, and which card an element belongs to. Keys, the pointer and motion
 * all start from here, so the page is described in one place.
 */
import type { InboxStop } from "@hercule/client-core/inbox";
import type { OpenTarget } from "./use-open-card";

/**
 * Matches the element of a card that has moves: a row of lasting work, a
 * request, or a part that rides on a row and asks something of the user.
 * Pointers ("Also in ..."), quiet and locked parts, and hints are not cards.
 */
export const CARD_SELECTOR =
  ".inbox-row[data-card-id], .inbox-request[data-card-id], .inbox-part[data-card-id]";

/** Matches what a row or a request is the first element of, the wrapper that holds the card with the parts and hints under it. */
const BUNDLE_SELECTOR = ".inbox-bundle";

/** Matches the card of a bundle that stands in a list of its own: a row or a request, never a part. */
const LEAD_SELECTOR = ":scope > .inbox-row[data-card-id], :scope > .inbox-request[data-card-id]";

/** Returns the element of the card `id` under `root`, or `null` when the page does not show it. */
export const findCardElement = (root: ParentNode, id: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(id)}"]`);

/**
 * Focuses the first Hand to row of the open card inside `root`, or does
 * nothing when there is none. The key H uses it when several workflows can
 * take the card: the user then chooses with the arrow keys or a number.
 */
export const focusFirstHandRow = (root: ParentNode): void => {
  root.querySelector<HTMLElement>("[data-sheet-hand-row]")?.focus({ preventScroll: true });
};

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
 * Returns the lead card (a row or a request) of the bundle `element` lies in,
 * or `null` when it lies in none. The parts and hints under a card belong to
 * its bundle, so a pointer anywhere on them points at the lead.
 */
export const readBundleLeadElement = (element: Element | null): HTMLElement | null =>
  element?.closest(BUNDLE_SELECTOR)?.querySelector<HTMLElement>(LEAD_SELECTOR) ?? null;

/**
 * Returns the id of the card that rises into the place of `element` when it
 * leaves: the card of the next bundle in the same list, or `undefined` when
 * something else, or nothing, follows (a heading, a pointer row, the end of the
 * list). A part has none: its neighbour is another part, which would not rise
 * into its place, only close up under it.
 */
const readFollowingCardId = (element: HTMLElement): string | undefined => {
  if (element.classList.contains("inbox-part")) return undefined;
  const next = element.closest(BUNDLE_SELECTOR)?.nextElementSibling;
  if (!(next instanceof HTMLElement) || !next.matches(BUNDLE_SELECTOR)) return undefined;
  return next.querySelector<HTMLElement>(LEAD_SELECTOR)?.dataset["cardId"];
};

/**
 * Returns every card on the page as a stop, in the order the page draws them:
 * the wide side first, then the narrow column, and a part right after its
 * lead. A card with a live Task carries `data-has-task` and no longer waits for
 * the user. A row or a request is followed by the card of the next bundle of
 * its list, if there is one: headings stand outside the lists, and pointer rows
 * are not bundles. A part is followed by nothing.
 */
export const readInboxStops = (root: ParentNode): readonly InboxStop[] =>
  Array.from(root.querySelectorAll<HTMLElement>(CARD_SELECTOR), (element) => {
    const rect = element.getBoundingClientRect();
    return {
      id: element.dataset["cardId"] ?? "",
      column: element.closest(".inbox-narrow") === null ? "wide" : "narrow",
      middle: rect.top + rect.height / 2,
      waits: !element.hasAttribute("data-has-task"),
      followedBy: readFollowingCardId(element),
    };
  });
