/**
 * The motion of handing a card to a colleague, and of Undo, which plays it
 * backwards. One click is one chain, cause before effect:
 *
 * - At once, the wait fades away over 120ms (a copy of it, as the wait is no
 *   longer drawn), and the colleague rises 22px into its place on `hand`.
 * - At 170ms the colleague takes the weight (a knock of 150), the sentence
 *   rolls to the new words, and the card's mark flies to Overview.
 * - Undo flies the mark home in 240ms. Then the card stands up with an upward
 *   knock, the sentence rolls back, and the colleague sinks away on `travel`.
 *
 * These functions animate a card that React has already drawn in its new
 * state, like `riseMonogram` does, so the caller reads what the old state
 * looked like first (`holdHandOff`) and plays the move in the same frame it
 * commits the change. Nothing here uses a timer: the chain is delays on Web
 * Animations and on bodies, so cancelling stops all of it and a late callback
 * cannot play a hand-off that was reversed.
 *
 * The page marks what the chain moves with attributes: the colleague's face
 * is `data-hand-off-colleague`, the card's plugin mark (the thing that flies)
 * is `data-hand-off-mark` (or, for a row with none, the mark in its place's
 * head), the wait is the figure with `data-level`, and the
 * sentence is the landing's `data-landing-sentence`.
 */
import {
  copyElementWithoutIds,
  findBody,
  flyHomeFromSidebarTarget,
  flyToSidebarTarget,
  isMotionReduced,
  knockElement,
  trackBody,
} from "../../app/motion";
import { riseHolder } from "./inbox-motion";
import { holdSentence, rollSentence, type HeldSentence } from "./landing";

const COLLEAGUE = "[data-hand-off-colleague]";
const MARK = "[data-hand-off-mark]";
/** The mark in the head of the place a card lies on, which a card with no mark of its own flies instead. */
const PLACE_MARK = ".place-mark";
const WAIT = "[data-level]";

/** How long after the colleague starts to rise it takes the weight, in milliseconds. */
const WEIGHT_DELAY = 170;

/** The speed of the knock when the colleague takes the weight, and when the card stands up, in pixels a second. A negative speed pushes up. */
const WEIGHT_SPEED = 150;
const STAND_UP_SPEED = -90;

/** How long the wait takes to fade away, in milliseconds. */
const WAIT_FADE = 120;

/** How far a colleague sinks to leave its place, in pixels: the height of its box. */
const SINK_DEPTH = 22;

/** A copy of a part a card had, and where it lay in the card. */
interface HeldPart {
  readonly copy: HTMLElement;
  readonly left: number;
  readonly top: number;
}

/** What a card looked like before a hand-off or an Undo changed it. */
export interface HeldHandOff {
  /** The old sentence, to roll away. Absent when the card has none. */
  readonly sentence: HeldSentence | undefined;
  /** The colleague the card had, to sink away on Undo. Absent when it had none. */
  readonly colleague: HeldPart | undefined;
  /** The wait the card had, to fade away on a hand-off. Absent when it had none. */
  readonly wait: HeldPart | undefined;
}

/**
 * Returns a copy of `part`, a part of `card`, to lay back over the card after
 * the part has left it, with where it lay in the card. The copy is hidden from
 * assistive technology: the card names what it needs to. `keepData` names the
 * `data-*` attributes the stylesheet draws the part by.
 */
const holdPart = (card: HTMLElement, part: HTMLElement, keepData: readonly string[]): HeldPart => {
  const copy = copyElementWithoutIds(part, keepData);
  for (const name of ["role", "aria-label", "title"]) copy.removeAttribute(name);
  copy.setAttribute("aria-hidden", "true");
  const cardRect = card.getBoundingClientRect();
  const partRect = part.getBoundingClientRect();
  return { copy, left: partRect.left - cardRect.left, top: partRect.top - cardRect.top };
};

/**
 * Records how `card` looks now: its sentence, its colleague and its wait, with
 * where each lies. Call it just before the change that hands the card on or
 * takes it back, then give the result to `playCardHandOff` or `playCardHandOffBack`.
 */
export const holdHandOff = (card: HTMLElement): HeldHandOff => {
  const box = card.querySelector(COLLEAGUE)?.parentElement ?? null;
  const wait = card.querySelector<HTMLElement>(WAIT);
  return {
    sentence: holdSentence(card),
    colleague: box === null ? undefined : holdPart(card, box, []),
    wait: wait === null ? undefined : holdPart(card, wait, ["data-level"]),
  };
};

/**
 * Returns the mark that flies for `card`: its own, or when a row has none
 * because the head of its place already shows the plugin's mark, the mark of
 * that head. Returns `null` when neither is drawn.
 */
const findMark = (card: HTMLElement): HTMLElement | null =>
  card.querySelector<HTMLElement>(MARK) ??
  card.closest(".inbox-place")?.querySelector<HTMLElement>(PLACE_MARK) ??
  null;

/** Lays `held` over `card` where it lay, out of the card's layout. */
const laySpare = (card: HTMLElement, held: HeldPart): HTMLElement => {
  Object.assign(held.copy.style, {
    position: "absolute",
    margin: "0",
    left: `${held.left}px`,
    top: `${held.top}px`,
  });
  card.append(held.copy);
  return held.copy;
};

/**
 * Lays the held wait over `card` and fades it out over 120ms, so the wait
 * goes as the colleague comes. Returns a function that stops the fade and
 * removes the copy.
 */
const fadeWaitAway = (card: HTMLElement, held: HeldPart): (() => void) => {
  const copy = laySpare(card, held);
  const fade = copy.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: WAIT_FADE,
    fill: "forwards",
  });
  fade.onfinish = () => {
    copy.remove();
  };
  return () => {
    fade.onfinish = null;
    fade.cancel();
    copy.remove();
  };
};

/**
 * Lays the held colleague back over `card` and, after `delay` milliseconds,
 * sinks it out of its box on `travel`. Returns a function that stops the
 * sinking and removes the copy.
 */
const sinkColleague = (card: HTMLElement, held: HeldPart, delay: number): (() => void) => {
  const copy = laySpare(card, held);
  const face = copy.firstElementChild;
  const remove = (): void => {
    if (face instanceof HTMLElement) findBody(face)?.clear();
    copy.remove();
  };
  if (face instanceof HTMLElement) {
    trackBody(face).to({ y: SINK_DEPTH }, "travel", { delay, done: remove });
  }
  return remove;
};

/**
 * Plays the hand-off of `card` to a colleague, on the card as React drew it
 * after the change. Returns a function that cancels all of it.
 *
 * - The wait fades away over 120ms, the colleague rises into its place, takes
 *   the weight at 170ms, and the sentence rolls from `held` to the new words
 *   at 170ms.
 * - The card's mark flies to Overview from 170ms, and Overview takes the
 *   receipt when it lands (`flyToSidebarTarget`).
 * - Under Reduce motion the colleague and the new words appear at once, the
 *   wait is gone, no mark flies, and Overview's row fades for 400ms.
 *
 * The card's neighbours do not move, and the signal landing's rim and knock
 * are not played: a hand-off is the user's own move, not news.
 */
export const playCardHandOff = (card: HTMLElement, held: HeldHandOff): (() => void) => {
  const cancels: (() => void)[] = [];
  const mark = findMark(card);
  if (mark !== null) cancels.push(flyToSidebarTarget(mark, "overview", WEIGHT_DELAY).cancel);
  if (!isMotionReduced()) {
    if (held.wait !== undefined) cancels.push(fadeWaitAway(card, held.wait));
    const colleague = card.querySelector<HTMLElement>(COLLEAGUE);
    if (colleague !== null) {
      riseHolder(colleague);
      const weight = knockElement(colleague, WEIGHT_SPEED, WEIGHT_DELAY);
      cancels.push(() => {
        findBody(colleague)?.clear();
        weight.cancel();
      });
    }
    if (held.sentence !== undefined) cancels.push(rollSentence(card, held.sentence, WEIGHT_DELAY));
  }
  return () => {
    for (const cancel of cancels) cancel();
  };
};

/**
 * Plays a hand-off backwards on `card`, as React drew it after Undo. Returns
 * a function that cancels all of it.
 *
 * - The mark flies home from Overview in 240ms, growing back
 *   (`flyHomeFromSidebarTarget`). Until then the old words stay and the
 *   colleague stays in its place.
 * - When the mark is home, the card stands up with an upward knock, the
 *   sentence rolls back from `held`, and the colleague sinks away on `travel`.
 * - Under Reduce motion nothing is animated: the card is as it should be.
 *   When the sidebar shows no Overview, the flight is skipped and the rest
 *   starts at once.
 */
export const playCardHandOffBack = (card: HTMLElement, held: HeldHandOff): (() => void) => {
  const cancels: (() => void)[] = [];
  const mark = findMark(card);
  const home = mark === null ? undefined : flyHomeFromSidebarTarget(mark, "overview");
  if (home !== undefined) cancels.push(home.cancel);
  if (!isMotionReduced()) {
    const wait = home?.ms ?? 0;
    const standUp = knockElement(card, STAND_UP_SPEED, wait);
    cancels.push(() => {
      standUp.cancel();
    });
    if (held.sentence !== undefined) cancels.push(rollSentence(card, held.sentence, wait));
    if (held.colleague !== undefined) cancels.push(sinkColleague(card, held.colleague, wait));
  }
  return () => {
    for (const cancel of cancels) cancel();
  };
};
