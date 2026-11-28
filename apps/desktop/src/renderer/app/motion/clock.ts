/**
 * The one animation clock. It asks for a frame only while something moves, so
 * the page does no work at rest, and it never reads the page.
 */

/** Something the clock moves each frame. */
export interface Moving {
  /** Moves `seconds` forward. Returns true when it has come to rest and the clock may let go of it. */
  advance(seconds: number): boolean;
  /** Runs once, right after `advance` returned true and the clock let go. It may start the thing moving again. */
  rest(): void;
}

/** The longest time one frame advances, in seconds, so a tab that was hidden resumes smoothly instead of jumping. */
const LONGEST_FRAME = 0.034;

const moving = new Set<Moving>();
let frame: number | null = null;
let lastTime = 0;

const tick = (time: number): void => {
  // The timestamp of a frame can fall before the `performance.now()` the
  // clock woke with, so the time between them can be negative.
  const seconds = Math.min(LONGEST_FRAME, Math.max(0, (time - lastTime) / 1000));
  lastTime = time;
  // A thing that comes to rest, or one that `rest` starts, changes the set
  // while it is walked. A set walk copes with both. The clock lets go before
  // calling `rest`, so a thing that `rest` sends off again stays in the set.
  for (const thing of moving) {
    if (!thing.advance(seconds)) continue;
    moving.delete(thing);
    thing.rest();
  }
  // `frame` stays set during the walk, so a thing started by a callback does not ask for a second frame.
  frame = moving.size > 0 ? requestAnimationFrame(tick) : null;
};

/** Starts moving `thing` each frame until it reports rest. Does nothing for a thing already moving. */
export const startMoving = (thing: Moving): void => {
  moving.add(thing);
  if (frame === null) {
    lastTime = performance.now();
    frame = requestAnimationFrame(tick);
  }
};

/** Stops moving `thing` at once, without waiting for rest. */
export const stopMoving = (thing: Moving): void => {
  moving.delete(thing);
};
