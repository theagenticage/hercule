/**
 * The motion of a hand-off. On H the row's wait rolls up out of its slot as
 * the colleague's face rolls in (`rollHandedRow`), 170ms later the face takes
 * a knock and the sentence rolls to "{Workflow} has it", and then the mark
 * flies to Work (`flyHandedMarkToWork`).
 *
 * The flight that ends a hand-off: the mark of the thing handed leaves its row
 * along an arc to Work in the sidebar, which takes a small knock and a wash.
 * It starts 170ms after the hand, as the colleague takes the weight, and takes
 * 420 to 760ms by distance (see `flyToSidebarTarget`).
 */
import { flushSync } from "react-dom";
import { buildSpringCurve, isMotionReduced, knockElement } from "../../app/motion";
import { flyToSidebarTarget, type SidebarFlight } from "../../app/motion/sidebar-flight";
import "./inbox-hand-roll.css";

/** How long after the hand the mark leaves its row, in milliseconds. */
const FLIGHT_DELAY_MS = 170;

/** A flight that was not drawn, for a row that is not on the page. */
const NO_FLIGHT: SidebarFlight = { cancel: () => undefined, ms: 0 };

/**
 * Flies the mark of the row `ref` to Work in the sidebar. Draws nothing, and
 * returns a flight that does nothing, when the row is not drawn (it is out of
 * the virtual list's reach) or the sidebar does not show Work. Returns the
 * flight, whose `cancel` stops it: Undo does that while the mark is in the air.
 */
export const flyHandedMarkToWork = (ref: string): SidebarFlight => {
  const mark = document.querySelector(`.ib-rows [data-ref="${CSS.escape(ref)}"] .ib-mark`);
  return mark instanceof HTMLElement
    ? flyToSidebarTarget(mark, "overview", FLIGHT_DELAY_MS)
    : NO_FLIGHT;
};

/** How far the old and the new part roll apart, in pixels. */
const ROLL_DISTANCE = 16;

/** When the face takes the weight and the sentence rolls, after the hand, in milliseconds. */
const SECOND_BEAT_MS = FLIGHT_DELAY_MS;

/** How hard the colleague's face is pushed down when it takes the weight, in pixels a second. */
const FACE_KNOCK_SPEED = 150;

/** A hand-off's roll that is not drawn. */
const NO_ROLL = { cancel: () => undefined };

/**
 * Lays a clip over the box `box` of `row` holding `old`, a copy of what the
 * box showed before the row changed. The clip cuts what rolls out of the box.
 * Returns the clip.
 */
const layOldCopy = (row: Element, box: DOMRect, old: Element): HTMLElement => {
  const at = row.getBoundingClientRect();
  const clip = document.createElement("div");
  clip.className = "ib-roll-clip";
  Object.assign(clip.style, {
    left: `${(box.left - at.left).toFixed(2)}px`,
    top: `${(box.top - at.top).toFixed(2)}px`,
    width: `${box.width.toFixed(2)}px`,
    height: `${box.height.toFixed(2)}px`,
  });
  clip.append(old);
  row.append(clip);
  return clip;
};

/**
 * Plays the hand-off's change on the row `ref`:
 *
 * - at once, the wait rolls up out of its slot as the colleague's face rolls
 *   in from below, both clipped to the line, on the `hand` spring;
 * - 170ms later the face takes a knock, and the sentence rolls up to the new
 *   one, clipped to its line.
 *
 * `change` makes the row draw its new state (the colleague and the new
 * sentence). It runs once, and the row is drawn anew when it returns. The old
 * slot and sentence are copies laid over the row, which roll away and are
 * removed when the roll ends.
 *
 * Under Reduce motion, or when the row is not drawn, only `change` runs.
 * Returns the roll, whose `cancel` stops it and removes everything it drew:
 * Undo does that during the chain. Putting the row back is the caller's.
 */
export const rollHandedRow = (ref: string, change: () => void): { readonly cancel: () => void } => {
  const row = document.querySelector(`.ib-rows [data-ref="${CSS.escape(ref)}"]`);
  const slot = row?.querySelector(".ib-row-time");
  const sentence = row?.querySelector(".ib-row-why");
  if (row == null || slot == null || sentence == null || isMotionReduced()) {
    change();
    return NO_ROLL;
  }
  const oldSlot = slot.cloneNode(true) as Element;
  const oldSentence = sentence.cloneNode(true) as Element;
  const slotBox = slot.getBoundingClientRect();
  const sentenceBox = sentence.getBoundingClientRect();
  // The row draws its new state now, so the new parts can be read and rolled in.
  flushSync(change);
  const newSlot = row.querySelector(".ib-row-time");
  const newSentence = row.querySelector(".ib-row-why");
  if (newSlot === null || newSentence === null) return NO_ROLL;

  const { ease, ms } = buildSpringCurve("hand");
  const clips = [layOldCopy(row, sentenceBox, oldSentence)];
  const lines = [newSentence.parentElement];
  const animations: Animation[] = [];
  const timing = (delay: number): KeyframeAnimationOptions => ({
    duration: ms,
    easing: ease,
    delay,
    fill: "both",
  });
  const rollUp = (leaving: Element, arriving: Element, delay: number): void => {
    animations.push(
      leaving.animate(
        [{ transform: "none" }, { transform: `translateY(-${String(ROLL_DISTANCE)}px)` }],
        timing(delay),
      ),
      arriving.animate(
        [{ transform: `translateY(${String(ROLL_DISTANCE)}px)` }, { transform: "none" }],
        timing(delay),
      ),
    );
  };
  // The face rolls in only where the row now shows one: with asks left, the wait stays.
  if (newSlot.classList.contains("ib-row-time--task")) {
    clips.push(layOldCopy(row, slotBox, oldSlot));
    lines.push(newSlot.parentElement);
    rollUp(oldSlot, newSlot, 0);
    animations.push(knockElement(newSlot, FACE_KNOCK_SPEED, SECOND_BEAT_MS));
  }
  rollUp(oldSentence, newSentence, SECOND_BEAT_MS);

  for (const line of lines) line?.setAttribute("data-rolling", "");
  let isDone = false;
  const clear = (): void => {
    if (isDone) return;
    isDone = true;
    for (const animation of animations) animation.cancel();
    for (const clip of clips) clip.remove();
    for (const line of lines) line?.removeAttribute("data-rolling");
  };
  let running = animations.length;
  for (const animation of animations) {
    animation.onfinish = () => {
      running -= 1;
      if (running === 0) clear();
    };
  }
  return { cancel: clear };
};
