import type { Velocity } from "./body";

/** How much of the old smoothed speed is kept at each pointer move: a shaky hand does not make a card shiver. */
const SPEED_KEPT = 0.7;

/** The shortest time one pointer move is taken to last, in milliseconds, so a burst of events gives no huge speed. */
const SHORTEST_MOVE_MS = 8;

/** How long the pointer must be still, in milliseconds, before the hand counts as having no speed. */
export const HAND_STILL_AFTER_MS = 60;

/** The fastest a hand is taken to throw a card, in pixels a second, so a flick does not fling the landing across the page. */
const FASTEST_THROW = 2500;

/**
 * Follows the pointer that carries a card: where it is, and how fast it moves.
 * A carried card leans with the speed and, when let go, lands with the speed
 * of the throw. The speed is smoothed over the last few moves.
 */
export class HandTracker {
  x: number;
  y: number;
  /** The smoothed speed in pixels a millisecond. */
  vx = 0;
  vy = 0;
  /** The time of the last move, from `performance.now()`. */
  movedAt: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
    this.movedAt = performance.now();
  }

  /** Records that the pointer is now at `x`, `y`, and updates the smoothed speed. */
  moveTo(x: number, y: number): void {
    const now = performance.now();
    const elapsed = Math.max(SHORTEST_MOVE_MS, now - this.movedAt);
    this.vx = this.vx * SPEED_KEPT + ((x - this.x) / elapsed) * (1 - SPEED_KEPT);
    this.vy = this.vy * SPEED_KEPT + ((y - this.y) / elapsed) * (1 - SPEED_KEPT);
    this.x = x;
    this.y = y;
    this.movedAt = now;
  }

  /** Returns whether the pointer has not moved for `HAND_STILL_AFTER_MS`. */
  isStill(): boolean {
    return performance.now() - this.movedAt > HAND_STILL_AFTER_MS;
  }

  /**
   * Returns the speed a card let go now is thrown at, in pixels a second: the
   * smoothed speed, never more than a fixed cap, and none once the hand has
   * been still.
   */
  readThrow(): Velocity {
    if (this.isStill()) return { x: 0, y: 0 };
    const limit = (speed: number): number =>
      Math.max(-FASTEST_THROW, Math.min(FASTEST_THROW, speed * 1000));
    return { x: limit(this.vx), y: limit(this.vy) };
  }
}
