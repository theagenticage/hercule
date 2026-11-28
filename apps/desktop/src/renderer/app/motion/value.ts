/**
 * A single number on a spring, for what a transform cannot do, such as a sheet
 * changing shape.
 */
import { startMoving, stopMoving, type Moving } from "./clock";
import { isMotionReduced } from "./reduced";
import {
  BODY_TOLERANCE,
  SPRINGS,
  SpringChannels,
  type SpringName,
  type Tolerance,
} from "./springs";

/**
 * A number settles within a two-thousandth of its unit. The body's tolerance
 * for a position, 0.08, would call a whole 0-to-1 fade finished before it
 * began.
 */
const VALUE_TOLERANCE: Tolerance = { ...BODY_TOLERANCE, x: 0.0005 };

/** A number on a spring. */
export interface MotionValue {
  /** The number as last given to `onChange`. */
  readonly current: number;
  /**
   * Sends the number to `goal`, from where it is with the speed it has. Under
   * Reduce motion it jumps. `done` runs when it comes to rest; a later `to`
   * or `set` replaces it.
   */
  to(goal: number, spring?: SpringName, done?: () => void): void;
  /** Puts the number exactly at `value`, at rest, and reports it. */
  set(value: number): void;
}

/** Makes a number that starts at `start` and reports each new value to `onChange`. */
export const animateValue = (start: number, onChange: (value: number) => void): MotionValue => {
  const channels = new SpringChannels(VALUE_TOLERANCE);
  channels.jump({ x: start });
  let onRest: (() => void) | null = null;
  const moving: Moving = {
    advance: (seconds) => {
      const atRest = channels.advance(seconds);
      onChange(channels.values.x);
      return atRest;
    },
    rest: () => {
      const done = onRest;
      onRest = null;
      done?.();
    },
  };
  const jump = (value: number): void => {
    stopMoving(moving);
    onRest = null;
    channels.jump({ x: value });
    onChange(value);
  };
  return {
    get current() {
      return channels.values.x;
    },
    to: (goal, spring = "travel", done) => {
      if (isMotionReduced()) {
        jump(goal);
        done?.();
        return;
      }
      channels.aim({ x: goal }, SPRINGS[spring]);
      onRest = done ?? null;
      startMoving(moving);
    },
    set: jump,
  };
};
