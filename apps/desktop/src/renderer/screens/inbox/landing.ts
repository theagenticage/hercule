/**
 * The moment a signal lands on a card, drawn on the page: the one time the
 * Inbox lets itself be noticed. A drop falls onto the line that will change
 * (`startDrop`), and when it lands the card takes a knock, its sentence rolls
 * over to the new words, and a rim of light fades (`playReaction`). A part that
 * rides on a card gets the same moment on its own row: its words rise into
 * place and its rim lights, and the card it rides on does nothing, so no card
 * ever changes place.
 *
 * Everything runs on the compositor as one `transform` or `opacity` animation
 * per new line, apart from the knock, which the motion kernel springs. No
 * timer is left behind. Under Reduce motion there is no drop, no knock and no
 * roll: the words change in place and the rim fades.
 */
import type { EntityReason } from "@hercule/contract";
import { buildSpringCurve, isMotionReduced, trackBody } from "../../app/motion";
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

/** The easing of the rim, which is the stylesheet's `--m-ease`: a Web Animation cannot read a custom property. */
const RIM_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

type CardKind = "row" | "request" | "part";

/** The line of a card that carries its sentence, and the sentence, for a row and for a request. */
const LINES = { row: ".row-context", request: ".request-under" } as const;
const SENTENCES = { row: ".row-news", request: ".request-said" } as const;

/**
 * The words of a part: its first line, which says what it asks, or the line
 * under it when it asks nothing. The query returns the first match in the
 * order of the page, so a part that asks gets its sentence.
 */
const PART_WORDS = ".part-said, .part-line";

const readKind = (element: HTMLElement): CardKind =>
  element.classList.contains("inbox-part")
    ? "part"
    : element.classList.contains("inbox-request")
      ? "request"
      : "row";

/**
 * Returns the element that draws the card `cardId` under `scroller`: a row, a
 * request, or a part that rides on a row (one that asks, or a quiet one). Returns
 * `null` when the page does not draw it, as when it lies in a closed "With
 * someone else".
 */
export const findLandingElement = (scroller: HTMLElement, cardId: string): HTMLElement | null =>
  findCardElement(scroller, cardId) ??
  scroller.querySelector<HTMLElement>(`.inbox-part[data-open-id="${CSS.escape(cardId)}"]`);

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

/** Returns the line a drop falls onto: the line of a card that carries its sentence, or the words of a part. */
const findSpot = (element: HTMLElement): Element | null => {
  const kind = readKind(element);
  return element.querySelector(kind === "part" ? PART_WORDS : LINES[kind]);
};

/**
 * Starts the drop of a signal that is about to land on `element`: a 7px dot
 * in the tone of the news appears 24px above the card and falls onto its line
 * over 360ms, stretching as it goes, and flattens where it lands. It removes
 * itself, and its layer when it is the last in it, when it ends. Does nothing
 * when the page has no layer or the element has no line to fall on. The
 * caller starts it as the card still shows its old words, and calls
 * `playReaction` `REACTION_DELAY_MS` later.
 */
export const startDrop = (scroller: HTMLElement, element: HTMLElement, tone: LandingTone): void => {
  const spot = findSpot(element)?.getBoundingClientRect();
  const layer = spot === undefined ? null : ensureCopyLayer(scroller);
  if (spot === undefined || layer === null) return;
  const origin = layer.getBoundingClientRect();
  const x = spot.left + 3 - origin.left;
  const y = spot.top + spot.height / 2 - origin.top;
  const from = element.getBoundingClientRect().top - DROP_HEIGHT - origin.top;
  const at = (top: number, scale: string): string =>
    `translate3d(${x.toFixed(1)}px,${top.toFixed(1)}px,0) scale(${scale})`;
  const drop = document.createElement("i");
  drop.className = "landing-drop";
  drop.dataset["tone"] = tone;
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
  const kind = readKind(element);
  if (kind === "part") return undefined;
  const line = element.querySelector(LINES[kind]);
  const sentence = line?.querySelector<HTMLElement>(SENTENCES[kind]);
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
 * the line; the clip leaves when it has gone. Does nothing when the new
 * sentence is missing.
 */
const rollSentence = (element: HTMLElement, kind: "row" | "request", held: HeldSentence): void => {
  const line = element.querySelector(LINES[kind]);
  const arrived = line?.querySelector<HTMLElement>(SENTENCES[kind]);
  if (line == null || arrived == null) return;
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
    { duration: ms, easing: ease, fill: "forwards" },
  );
  const arriving = arrived.animate(
    [{ transform: `translateY(${String(ROLL_DISTANCE)}px)` }, { transform: "none" }],
    { duration: ms, easing: ease },
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
};

/** The rim each element shows now, so a second rim on the same element takes over from the first. */
const rims = new WeakMap<HTMLElement, Animation>();

/**
 * Lights a 1.5px inner rim on `element`, at its own corner and in the tone of
 * the news (`plain` and `attention` use the user's color), which fades in
 * 1100ms: in by 14% of that time, then out. Under Reduce motion it is a plain
 * fade of 900ms. The rim is the `::after` of `.is-landed`, which the
 * stylesheet draws; the class and the tone go when the rim ends.
 */
export const lightRim = (element: HTMLElement, tone: LandingTone): void => {
  rims.get(element)?.cancel();
  if (tone === "bad" || tone === "good") element.dataset["landed"] = tone;
  else delete element.dataset["landed"];
  element.classList.add("is-landed");
  const rim = isMotionReduced()
    ? element.animate(
        { opacity: [1, 0] },
        { duration: RIM_REDUCED_MS, easing: "linear", pseudoElement: "::after" },
      )
    : element.animate(
        [
          { opacity: 0, easing: RIM_EASE },
          { opacity: 1, offset: 0.14, easing: RIM_EASE },
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
 * words are drawn. The rim lights. A row or a request takes a knock and rolls
 * its sentence from `held` to the new one. A part lifts its words 5px into
 * place and no card moves. Under Reduce motion only the rim plays.
 */
export const playReaction = (
  element: HTMLElement,
  tone: LandingTone,
  held: HeldSentence | undefined,
): void => {
  lightRim(element, tone);
  if (isMotionReduced()) return;
  const kind = readKind(element);
  if (kind === "part") {
    element.querySelector(PART_WORDS)?.animate(
      [
        { transform: `translateY(${String(RISE_DISTANCE)}px)`, opacity: 0 },
        { transform: "none", opacity: 1 },
      ],
      { duration: RISE_MS, easing: "cubic-bezier(.22, .9, .24, 1)" },
    );
    return;
  }
  trackBody(element).kick({ y: KNOCK_SPEED });
  if (held !== undefined) rollSentence(element, kind, held);
};
