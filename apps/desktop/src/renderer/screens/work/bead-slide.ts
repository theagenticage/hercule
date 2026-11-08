/**
 * The numbers of sliding a bead along its line, worked out from measurements
 * taken once when the slide starts. Nothing here reads the page.
 */

/** How far the pointer moves, in pixels, before a press on a bead becomes a slide. Up to this far is a click. */
export const SLIDE_DISTANCE = 4;

/** The scale of a bead in the hand. */
export const HELD_BEAD_SCALE = 1.5;

/** How near the bead's left edge must come to the start of a stage, in pixels, for the stage to pull it. */
const NOTCH_REACH = 26;

/** The share of the distance to the start of a stage that the stage pulls the bead. */
const NOTCH_PULL = 0.45;

/**
 * Returns how many pixels sideways a bead whose left edge is at `beadLeft`
 * is pulled toward the nearest stage start in `stageLefts`: 45% of the
 * distance, like a bead finding a notch, and nothing when no stage start is
 * within 26px.
 */
export const computeNotchPull = (beadLeft: number, stageLefts: readonly number[]): number => {
  let nearest: number | undefined;
  for (const left of stageLefts) {
    const distance = left - beadLeft;
    if (
      Math.abs(distance) < NOTCH_REACH &&
      (nearest === undefined || Math.abs(distance) < Math.abs(nearest))
    ) {
      nearest = distance;
    }
  }
  return nearest === undefined ? 0 : nearest * NOTCH_PULL;
};

/**
 * Returns how far right of its resting place a bead is drawn when the pointer
 * has moved `pointerTravel` pixels since the press: one to one with the
 * pointer, plus the pull of the stage it passes (`computeNotchPull`).
 * `restingLeft` is the bead's left edge before it moved.
 */
export const computeSlideOffset = (
  restingLeft: number,
  pointerTravel: number,
  stageLefts: readonly number[],
): number => pointerTravel + computeNotchPull(restingLeft + pointerTravel, stageLefts);
