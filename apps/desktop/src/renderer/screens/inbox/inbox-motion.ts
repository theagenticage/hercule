/**
 * The motion of the Inbox's moves, on the shared kernel: the page closing up
 * or parting around a card (`flipInboxPage`), the copy of a dismissed card
 * stepping aside, a card coming back, and a monogram rising into the wait's
 * place. Everything moves `transform` and `opacity` only, and under Reduce
 * motion the kernel turns it into a short fade.
 */
import {
  ensureOverlayLayer,
  findBody,
  flipByKey,
  ghostElement,
  trackBody,
  type FlipByKeyResult,
  type SpringName,
} from "../../app/motion";

/** How far a dismissed card steps aside, and a restored card comes back from, in pixels. */
const STEP_ASIDE = 14;

/** How far a monogram sits below its place before it rises into it, in pixels. */
const HOLDER_DEPTH = 22;

/** How far above its place a card that arrived by itself starts, in pixels. */
const ARRIVAL_DEPTH = 20;

/**
 * What moves when the page changes: cards, the pointers to them, the stock and
 * head of a place, the toggle of With someone else, and the lines that close
 * up under a card. A card's own parts and the rows inside a place's stock are
 * not listed, because they ride with their parent: a part and its parent
 * moving both would count the move twice.
 */
const MOVABLE_SELECTOR = [
  "[data-card-id]",
  "[data-pointer-to]",
  ".inbox-place > .card-stock",
  ".inbox-place-head",
  ".inbox-else-toggle",
  ".inbox-requests-label",
  ".inbox-requests-clear",
  ".inbox-none",
  ".inbox-note",
].join(", ");

/**
 * Returns the key that tells `element` apart from its neighbours across a
 * change, or `null` for an element to leave alone. A card is one element on
 * the page, and keeps its key when it moves to another place. A pointer is
 * told apart by the card it points to and the place it lies under.
 */
const readMotionKey = (element: HTMLElement): string | null => {
  const place = element.closest<HTMLElement>(".inbox-place")?.dataset["place"] ?? "";
  const { cardId, pointerTo } = element.dataset;
  if (element.classList.contains("is-ghost")) return null;
  if (cardId !== undefined) return `card:${cardId}`;
  if (pointerTo !== undefined) return `pointer:${pointerTo}@${place}`;
  if (element.matches(".inbox-place > .card-stock")) return `stock:${place}`;
  if (element.matches(".inbox-place-head")) return `head:${place}`;
  if (element.matches(".inbox-requests-label")) return `label:${element.textContent}`;
  if (element.matches(".inbox-else-toggle")) return "else";
  if (element.matches(".inbox-requests-clear")) return "no-requests";
  if (element.matches(".inbox-none")) return `none:${element.textContent}`;
  return "note";
};

/**
 * Runs `mutate`, which must commit its change to the page before it returns,
 * and moves every part of the page that the change moved from where it was to
 * where it is now, on `spring`. Returns the places after the change and the
 * parts that are new (`flipByKey`).
 */
export const flipInboxPage = (
  scroller: HTMLElement,
  spring: SpringName,
  mutate: () => void,
): FlipByKeyResult =>
  flipByKey({ root: scroller, selector: MOVABLE_SELECTOR, readKey: readMotionKey, spring, mutate });

/**
 * Returns the layer for copies of cards that step aside. It lies over the
 * page and under the toolbar, with the page's own edges, so a copy is
 * clipped where the page is.
 */
const ensureCopyLayer = (scroller: HTMLElement): HTMLElement | null => {
  const desk = scroller.closest<HTMLElement>(".inbox-desk");
  return desk === null ? null : ensureOverlayLayer(desk, "inbox-copies");
};

/**
 * Makes a copy of the card `element`, looking as it does now, to step aside
 * after the card has left the page. Call it before the change that removes
 * the card, then hand the copy to `stepAside`. Returns `null` when the page
 * has no layer to hold it.
 */
export const copyCardToStepAside = (
  scroller: HTMLElement,
  element: HTMLElement,
): HTMLElement | null => {
  const layer = ensureCopyLayer(scroller);
  if (layer === null) return null;
  const copy = ghostElement(element, layer);
  // The copy is not a card: keys, the pointer and the motion key must never find it.
  copy.removeAttribute("data-card-id");
  copy.removeAttribute("role");
  copy.removeAttribute("data-current");
  return copy;
};

/** Moves the copy 14px to the right while it fades, on `travel`, then removes it and its layer when it is the last. */
export const stepAside = (copy: HTMLElement): void => {
  trackBody(copy).to({ x: STEP_ASIDE, o: 0 }, "travel", {
    done: () => {
      const layer = copy.parentElement;
      findBody(copy)?.clear();
      copy.remove();
      if (layer?.childElementCount === 0) layer.remove();
    },
  });
};

/** Brings back a card that a dismissal took away: it comes from 14px to the right and fades in, on `travel`. */
export const comeBackFromAside = (card: HTMLElement): void => {
  const body = trackBody(card);
  body.set({ x: STEP_ASIDE, o: 0 });
  body.to({ x: 0, o: 1 }, "travel");
};

/** Lets a card that nobody asked for come down 20px into its place and fade in, on `self`. */
export const comeDownIntoPlace = (card: HTMLElement): void => {
  const body = trackBody(card);
  body.set({ y: -ARRIVAL_DEPTH, o: 0 });
  body.to({ y: 0, o: 1 }, "self");
};

/** Lifts the monogram of `card` into the wait's place: it rises 22px on `hand`, clipped by its box. */
export const riseMonogram = (card: HTMLElement): void => {
  const monogram = card.querySelector<HTMLElement>(".card-taken-in");
  if (monogram === null) return;
  const body = trackBody(monogram);
  body.set({ y: HOLDER_DEPTH });
  body.to({ y: 0 }, "hand");
};
