/**
 * The moment a signal lands on a card, drawn on the page: the one time the
 * Inbox lets itself be noticed. A drop falls onto the line that will change
 * (`startDrops`), and when it lands the card takes a knock, its sentence rolls
 * over to the new words, and a rim of light fades (`playReaction`). A part that
 * rides on a card gets the same moment on its own row: its words rise into
 * place and its rim lights, and the card it rides on does nothing, so no card
 * ever changes place.
 *
 * Everything runs on the compositor as one `transform` or `opacity` animation
 * per new line, the knock included (`buildSpringKnock` turns its spring into
 * the keyframes). No timer is left behind. Under Reduce motion there is no
 * drop, no knock and no roll: the words change in place and the rim fades.
 *
 * The page marks what the landing reads and moves with attributes: a part that
 * rides on a card is `data-landing-part`, the line of a card that carries its
 * sentence (and the first line of a part) is `data-landing-line`, and the
 * sentence inside a line is `data-landing-sentence`.
 */
import type { EntityReason } from "@hercule/contract";
import { buildSpringCurve, knockElement, MOTION_EASE } from "../../app/motion";
import { ensureCopyLayer } from "./inbox-motion";
import { findCardElement } from "./inbox-page-dom";

/** The tone of a landed signal, which colors its drop and its rim. */
export type LandingTone = EntityReason["tone"];

/**
 * How long after the drop starts the card reacts, in milliseconds. The drop's
 * easing makes it touch the line a little later than this; that is how the
 * drawing it comes from is built, and it reads as the card meeting the drop.
 */
export const REACTION_DELAY_MS = 281;

/** How long the drop takes, and how far above the card it starts, in pixels. */
const DROP_MS = 360;
const DROP_HEIGHT = 24;

/** The speed of the knock the card takes when the drop lands, in pixels a second. It peaks at about 2px. */
const KNOCK_SPEED = 145;

/** How far apart the old and the new sentence roll, in pixels. */
const ROLL_DISTANCE = 16;

/** How far below its place a part's words start, and how long they take to rise. */
const RISE_DISTANCE = 5;
const RISE_MS = 240;

/** How long the rim takes, with and without Reduce motion. */
const RIM_MS = 1100;
const RIM_REDUCED_MS = 900;

/**
 * What the page marks. The line of a card is the one that carries its
 * sentence; the words of a part are its first line, which says what it asks,
 * or the line under it when it asks nothing. A query returns the first match
 * in the order of the page, so a part that asks gets its sentence.
 */
const PART = "[data-landing-part]";
const LINE = "[data-landing-line]";
const SENTENCE = "[data-landing-sentence]";

/**
 * Returns the element that draws the card `cardId` under `scroller`: a row, a
 * request, or a part that rides on a row (one that asks, or a quiet one). Returns
 * `null` when the page does not draw it, as when it lies in a closed "With
 * someone else".
 */
export const findLandingElement = (scroller: HTMLElement, cardId: string): HTMLElement | null =>
  findCardElement(scroller, cardId) ??
  scroller.querySelector<HTMLElement>(`${PART}[data-open-id="${CSS.escape(cardId)}"]`);

/**
 * Checks whether `element` can be seen on the page now: it takes room, and
 * its box meets the box of `scroller`. A card that is scrolled away or
 * hidden plays nothing of the landing, though its words still change.
 */
export const isShownOnPage = (scroller: HTMLElement, element: HTMLElement): boolean => {
  if (element.getClientRects().length === 0) return false;
  const page = scroller.getBoundingClientRect();
  const box = element.getBoundingClientRect();
  return box.bottom > page.top && box.top < page.bottom;
};

/** Where a drop falls and where it starts, in window pixels, as measured on the page. */
export interface DropPlan {
  readonly tone: LandingTone;
  /** The left edge of the line the drop falls onto. */
  readonly lineLeft: number;
  /** The vertical middle of that line. */
  readonly lineMiddle: number;
  /** The top of the card, from which the drop starts `DROP_HEIGHT` above. */
  readonly cardTop: number;
}

/**
 * Measures where a signal of `tone` will fall onto `element`: its line, and
 * where the card lies. Only reads the page, so a caller can plan every card
 * of a landing before it writes anything (`startDrops`). Returns `undefined`
 * when the element has no line to fall on.
 */
export const planDrop = (element: HTMLElement, tone: LandingTone): DropPlan | undefined => {
  const line = element.querySelector(LINE);
  if (line === null) return undefined;
  const spot = line.getBoundingClientRect();
  return {
    tone,
    lineLeft: spot.left,
    lineMiddle: spot.top + spot.height / 2,
    cardTop: element.getBoundingClientRect().top,
  };
};

/**
 * Starts the drops planned by `planDrop`: for each, a 7px dot in the tone of
 * the news appears 24px above its card and falls onto the line over 360ms,
 * stretching as it goes, and flattens where it lands. Each removes itself, and
 * the layer when it is the last in it, when it ends. Does nothing when the
 * page has no layer. The caller starts them as the cards still show their old
 * words, and calls `playReaction` `REACTION_DELAY_MS` later.
 *
 * The layer is measured once for all the drops, and only after it is made, so
 * a landing on many cards costs one layout and not one for each.
 */
export const startDrops = (scroller: HTMLElement, plans: readonly DropPlan[]): void => {
  if (plans.length === 0) return;
  const layer = ensureCopyLayer(scroller);
  if (layer === null) return;
  const origin = layer.getBoundingClientRect();
  for (const plan of plans) {
    const x = plan.lineLeft + 3 - origin.left;
    const y = plan.lineMiddle - origin.top;
    const from = plan.cardTop - DROP_HEIGHT - origin.top;
    const at = (top: number, scale: string): string =>
      `translate3d(${x.toFixed(1)}px,${top.toFixed(1)}px,0) scale(${scale})`;
    const drop = document.createElement("i");
    drop.className = "landing-drop";
    drop.dataset["tone"] = plan.tone;
    layer.append(drop);
    const flight = drop.animate(
      [
        { transform: at(from, ".7,1"), opacity: 0 },
        { transform: at(from + 12, ".85,1.2"), opacity: 1, offset: 0.2 },
        { transform: at(y, ".85,1.35"), opacity: 1, offset: 0.78, easing: "linear" },
        { transform: at(y, "1.5,.55"), opacity: 1, offset: 0.84 },
        { transform: at(y, "1.5,.55"), opacity: 0 },
      ],
      { duration: DROP_MS, easing: "cubic-bezier(.4, 0, .9, .8)" },
    );
    const land = (): void => {
      drop.remove();
      if (layer.childElementCount === 0) layer.remove();
    };
    flight.onfinish = land;
    flight.oncancel = land;
  }
};

/** The sentence of a card as it was before the landing, and where the card, its line and the sentence lay. */
export interface HeldSentence {
  /** A copy of the old sentence, to roll away. */
  readonly sentence: HTMLElement;
  readonly card: DOMRect;
  readonly line: DOMRect;
  readonly place: DOMRect;
}

/**
 * Returns a copy of the sentence `element` shows now, with where it lies, so
 * `playReaction` can roll it away after the new words are drawn. Call it just
 * before the words change. Returns `undefined` for a part, which does not
 * roll, and for a card with no sentence.
 */
export const holdSentence = (element: HTMLElement): HeldSentence | undefined => {
  if (element.matches(PART)) return undefined;
  const line = element.querySelector(LINE);
  const sentence = line?.querySelector<HTMLElement>(SENTENCE);
  if (line == null || sentence == null) return undefined;
  return {
    sentence: sentence.cloneNode(true) as HTMLElement,
    card: element.getBoundingClientRect(),
    line: line.getBoundingClientRect(),
    place: sentence.getBoundingClientRect(),
  };
};

/**
 * Rolls a card's line from its old sentence to the new one. Both move
 * together on the `hand` spring, 16px apart, and the line clips them, so the
 * two sentences never show at once. The old one is a copy in a clip laid over
 * the line; the clip leaves when it has gone.
 *
 * The roll starts after `delay` milliseconds. Until then the old sentence
 * stands in its place and the new one waits below the line's edge, so a
 * caller can start the roll when something else has happened. Returns a
 * function that stops the roll and leaves the new sentence in place; it is
 * safe to call after the roll has ended. Does nothing, and returns a function
 * that does nothing, when the new sentence is missing.
 */
export const rollSentence = (element: HTMLElement, held: HeldSentence, delay = 0): (() => void) => {
  const line = element.querySelector(LINE);
  const arrived = line?.querySelector<HTMLElement>(SENTENCE);
  if (line == null || arrived == null) return () => {};
  const { ease, ms } = buildSpringCurve("hand");
  const clip = document.createElement("div");
  clip.className = "card-line-clip";
  Object.assign(clip.style, {
    left: `${(held.line.left - held.card.left).toFixed(2)}px`,
    top: `${(held.line.top - held.card.top).toFixed(2)}px`,
    width: `${held.line.width.toFixed(2)}px`,
    height: `${held.line.height.toFixed(2)}px`,
  });
  Object.assign(held.sentence.style, {
    left: `${(held.place.left - held.line.left).toFixed(2)}px`,
    top: `${(held.place.top - held.line.top).toFixed(2)}px`,
    width: `${held.place.width.toFixed(2)}px`,
    height: `${held.place.height.toFixed(2)}px`,
  });
  clip.append(held.sentence);
  element.append(clip);
  line.classList.add("is-rolling");
  const leaving = held.sentence.animate(
    [{ transform: "none" }, { transform: `translateY(-${String(ROLL_DISTANCE)}px)` }],
    { duration: ms, delay, easing: ease, fill: "both" },
  );
  const arriving = arrived.animate(
    [{ transform: `translateY(${String(ROLL_DISTANCE)}px)` }, { transform: "none" }],
    { duration: ms, delay, easing: ease, fill: "backwards" },
  );
  const clearClip = (): void => {
    clip.remove();
  };
  const clearRolling = (): void => {
    line.classList.remove("is-rolling");
  };
  leaving.onfinish = clearClip;
  leaving.oncancel = clearClip;
  arriving.onfinish = clearRolling;
  arriving.oncancel = clearRolling;
  return () => {
    leaving.cancel();
    arriving.cancel();
  };
};

/** The rim each element shows now, so a second rim on the same element takes over from the first. */
const rims = new WeakMap<HTMLElement, Animation>();

/**
 * Lights a 1.5px inner rim on `element`, at its own corner and in the tone of
 * the news (`plain` and `attention` use the user's color), which fades in
 * 1100ms: in by 14% of that time, then out. Under Reduce motion it is a plain
 * fade of 900ms. The rim is the `::after` of `.is-landed`, which the
 * stylesheet draws; the class and the tone go when the rim ends. `isReduced`
 * is whether the reader asked for no movement, which the caller reads once for
 * the whole landing: reading it here would cost a style lookup for each card.
 */
export const lightRim = (element: HTMLElement, tone: LandingTone, isReduced: boolean): void => {
  rims.get(element)?.cancel();
  if (tone === "bad" || tone === "good") element.dataset["landed"] = tone;
  else delete element.dataset["landed"];
  element.classList.add("is-landed");
  const rim = isReduced
    ? element.animate(
        { opacity: [1, 0] },
        { duration: RIM_REDUCED_MS, easing: "linear", pseudoElement: "::after" },
      )
    : element.animate(
        [
          { opacity: 0, easing: MOTION_EASE },
          { opacity: 1, offset: 0.14, easing: MOTION_EASE },
          { opacity: 0 },
        ],
        { duration: RIM_MS, pseudoElement: "::after" },
      );
  rims.set(element, rim);
  const end = (): void => {
    // A rim that a later one replaced leaves the class to the later one.
    if (rims.get(element) !== rim) return;
    rims.delete(element);
    element.classList.remove("is-landed");
    delete element.dataset["landed"];
  };
  rim.onfinish = end;
  rim.oncancel = end;
};

/**
 * Plays what happens when the drop has landed on `element`, after its new
 * words are drawn, and Reduce motion is off (under it, `lightRim` alone
 * plays). The rim lights. A row or a request takes a knock, a push down that
 * its spring brings back, and rolls its sentence from `held` to the new one. A
 * part lifts its words 5px into place and no card moves.
 *
 * The knock is a Web Animation that adds to the card's own transform, so it
 * costs the main thread nothing and a card that is also being moved is not
 * disturbed.
 */
export const playReaction = (
  element: HTMLElement,
  tone: LandingTone,
  held: HeldSentence | undefined,
): void => {
  lightRim(element, tone, false);
  if (element.matches(PART)) {
    element.querySelector(LINE)?.animate(
      [
        { transform: `translateY(${String(RISE_DISTANCE)}px)`, opacity: 0 },
        { transform: "none", opacity: 1 },
      ],
      { duration: RISE_MS, easing: "cubic-bezier(.22, .9, .24, 1)" },
    );
    return;
  }
  knockElement(element, KNOCK_SPEED);
  if (held !== undefined) rollSentence(element, held);
};
