/**
 * Where a Task's details sheet grows from and goes back to, found on the
 * board as it is right now, and the dent a card leaves while its sheet is up.
 * Each function reads the page when it is called and holds nothing, so a
 * sheet never grows toward a place that was measured earlier and has moved.
 */
import type { SheetOrigin } from "../desk";

/** The attribute of the card whose sheet is open. It is set from outside React, which never writes it. */
const DENT_ATTRIBUTE = "data-away";

/** Where on the board a Task is, as far as the board draws it. `null` means the board does not have it. */
export interface TaskPlace {
  readonly taskId: string;
  /** The id of the Task's lane. */
  readonly laneId: string;
  /** The id of the cell of the Task's stage in its lane. */
  readonly cellId: string;
  /** The Task's stage. */
  readonly stage: string;
}

/**
 * Returns how far down the sticky stage headers cover the board's top, in
 * window pixels. A card under them is not in view.
 */
const findCoveredTop = (scroller: HTMLElement): number =>
  scroller.querySelector(".board-rule-wrap")?.getBoundingClientRect().bottom ??
  scroller.getBoundingClientRect().top;

/** Returns whether any of `rect` shows on the board: inside the scroller, below the sticky headers. */
const isShownOnBoard = (rect: DOMRect, scroller: HTMLElement): boolean => {
  const view = scroller.getBoundingClientRect();
  return (
    rect.bottom > findCoveredTop(scroller) &&
    rect.top < view.bottom &&
    rect.right > view.left &&
    rect.left < view.right
  );
};

/**
 * Returns a copy of a card as the sheet carries it: the same words and age,
 * with nothing to click, no id to repeat, and hidden from assistive
 * technology. The card's own look may carry the dent, a focus ring or a move
 * in flight, and the copy takes none of them.
 */
const copyCardWords = (card: HTMLElement): HTMLElement => {
  const copy = card.cloneNode(true) as HTMLElement;
  for (const attribute of [
    "id",
    "tabindex",
    "role",
    "aria-label",
    "data-card-id",
    DENT_ATTRIBUTE,
  ]) {
    copy.removeAttribute(attribute);
  }
  copy.classList.remove("is-focus", "is-moving", "is-rising", "is-carried");
  copy.style.cssText = "";
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  return copy;
};

/**
 * Finds where the sheet of the Task at `place` grows from, in this order:
 *
 * 1. The Task's card, when it shows on the board. The origin carries a copy
 *    of the card's words.
 * 2. The line that holds the card behind it ("13 more", "3 landed").
 * 3. The count of the card's stage on its lane's folded line.
 * 4. Nothing, when the Task is not on the board or none of these shows. The
 *    sheet then grows from a smaller sheet inside its own place.
 *
 * A place that is scrolled out of view is never chosen: the sheet would fly
 * across the screen toward something nobody can see.
 */
export const readSheetOrigin = (
  scroller: HTMLElement | null,
  place: TaskPlace | null,
): SheetOrigin => {
  if (scroller === null || place === null) return { rect: null, words: null };
  const card = scroller.querySelector<HTMLElement>(`[data-card-id="${place.taskId}"]`);
  if (card !== null) {
    const rect = card.getBoundingClientRect();
    if (isShownOnBoard(rect, scroller)) return { rect, words: copyCardWords(card) };
  }
  const stand: Array<Element | null> = [
    scroller.querySelector(`[data-more-cell-id="${place.cellId}"]`),
    scroller.querySelector(
      `[data-lane-id="${place.laneId}"] [data-fold-row] [data-stage="${place.stage}"]`,
    ),
  ];
  for (const element of stand) {
    const rect = element?.getBoundingClientRect();
    if (rect !== undefined && isShownOnBoard(rect, scroller)) return { rect, words: null };
  }
  return { rect: null, words: null };
};

/**
 * Leaves the dent on the card of `taskId`, and takes it off every other card:
 * the card's words go and its sheet shows faintly, so the eye knows where the
 * sheet goes back to. With `null`, no card has a dent. Call it after the board
 * draws, because a card the board draws again is a new element.
 */
export const markCardDent = (scroller: HTMLElement | null, taskId: string | null): void => {
  if (scroller === null) return;
  const marked = scroller.querySelectorAll<HTMLElement>(`[${DENT_ATTRIBUTE}]`);
  const target =
    taskId === null ? null : scroller.querySelector<HTMLElement>(`[data-card-id="${taskId}"]`);
  for (const card of marked) {
    if (card !== target) card.removeAttribute(DENT_ATTRIBUTE);
  }
  target?.setAttribute(DENT_ATTRIBUTE, "");
};
