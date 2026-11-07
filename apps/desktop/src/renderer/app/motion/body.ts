/**
 * The body: an element with a position offset, a scale, a tilt, an opacity and
 * a lift, each on its own spring. Asking a body to go somewhere new while it
 * moves keeps the speed it has, so a reversal looks like one continuous motion.
 */
import { startMoving, stopMoving, type Moving } from "./clock";
import { isMotionReduced } from "./reduced";
import {
  BODY_TOLERANCE,
  SPRINGS,
  SpringChannels,
  type Channel,
  type ChannelValues,
  type PartialChannelValues,
  type Spring,
  type SpringName,
} from "./springs";

/** How a body is sent somewhere. */
interface MoveOptions {
  /** Milliseconds to wait before the body starts. Ignored under Reduce motion. */
  readonly delay?: number;
  /** Runs when the body comes to rest on this move's goal. A later move replaces it. */
  readonly done?: () => void;
  /**
   * The result of `isMotionReduced()`, for a caller that moves many bodies in
   * one go: reading it costs a style lookup, and a caller that has just
   * written styles should not pay it once per body.
   */
  readonly reduced?: boolean;
}

/** How fast an offset changes, in pixels a second. */
export interface Velocity {
  readonly x: number;
  readonly y: number;
}

/** The class the stylesheet turns into `will-change`, set only while the body moves. */
export const MOVING_CLASS = "is-moving";

/** The class `flipByKey` puts on an element that rises, so a stylesheet can stack it over what it passes. */
export const RISING_CLASS = "is-rising";

/** A body that has left rest but waits for its delay, and where it goes then. */
interface DelayedMove {
  readonly goal: PartialChannelValues;
  readonly spring: Spring;
}

/**
 * Writes the body's values to the element: `transform`, `opacity` and the
 * `--lift` custom property, and nothing else. At rest the element goes back
 * to its stylesheet, with no inline style.
 */
export class MotionBody implements Moving {
  private readonly channels = new SpringChannels(BODY_TOLERANCE);
  private waitMilliseconds = 0;
  private delayed: DelayedMove | null = null;
  private onRest: (() => void) | null = null;
  private isLifted = false;
  private isUnderway = false;
  private readonly element: HTMLElement;

  constructor(element: HTMLElement) {
    this.element = element;
  }

  /** The values the element shows right now. */
  get values(): ChannelValues {
    return this.channels.values;
  }

  /**
   * Sends the body to `goal` on a spring, from where it is with the speed it
   * has. Under Reduce motion every channel jumps to its goal at once, except
   * opacity, which fades on `travel`.
   */
  to(goal: PartialChannelValues, spring: SpringName = "hand", options: MoveOptions = {}): void {
    if (options.reduced ?? isMotionReduced()) {
      const { o: opacity, ...rest } = goal;
      this.set(rest);
      this.waitMilliseconds = 0;
      this.delayed = null;
      if (opacity === undefined) {
        options.done?.();
        return;
      }
      this.channels.aim({ o: opacity }, SPRINGS.travel);
    } else if (options.delay) {
      this.waitMilliseconds = options.delay;
      this.delayed = { goal, spring: SPRINGS[spring] };
    } else {
      this.waitMilliseconds = 0;
      this.delayed = null;
      this.channels.aim(goal, SPRINGS[spring]);
    }
    this.onRest = options.done ?? null;
    this.isUnderway = true;
    this.element.classList.add(MOVING_CLASS);
    startMoving(this);
  }

  /**
   * Gives the body a push: adds `speeds` (the channel's unit a second) to the
   * speed each named channel has now, so it moves off and comes back to its
   * goal by itself, as a knock on a card does. A body at rest is aimed at the
   * goal it has, on `spring`. A body already on its way keeps its goal, its
   * spring and what it does on arrival, and only gains the speed. Under Reduce
   * motion it does nothing.
   */
  kick(speeds: PartialChannelValues, spring: SpringName = "hand"): void {
    if (isMotionReduced()) return;
    const kicked = Object.entries(speeds) as [Channel, number][];
    for (const [channel, speed] of kicked) {
      this.channels.setSpeed(channel, this.channels.readSpeed(channel) + speed);
    }
    if (!this.isUnderway) {
      const goals = Object.fromEntries(
        kicked.map(([channel]) => [channel, this.channels.goals[channel]]),
      );
      this.channels.aim(goals, SPRINGS[spring]);
      this.onRest = null;
      this.isUnderway = true;
    }
    this.element.classList.add(MOVING_CLASS);
    startMoving(this);
  }

  /** Puts the given channels exactly at these values, at rest, and draws them. */
  set(values: PartialChannelValues): void {
    this.channels.jump(values);
    this.paint();
  }

  /** Puts the body exactly at `x`, `y` this frame, so a carried card follows the pointer one to one. */
  follow(x: number, y: number): void {
    this.set({ x, y });
  }

  /** How fast the offset changes now, in pixels a second. */
  get velocity(): Velocity {
    return { x: this.channels.readSpeed("x"), y: this.channels.readSpeed("y") };
  }

  /**
   * Puts the offset at `x`, `y` and draws it, keeping the goal. Used when the
   * layout moved under a body: the offset that keeps it where it looks is
   * new, and the motion it had goes on from there. The speed stays as it is,
   * unless `velocity` gives one: a body that takes over from another element
   * starts with that element's speed.
   */
  relocate(x: number, y: number, velocity?: Velocity): void {
    this.channels.relocate("x", x);
    this.channels.relocate("y", y);
    if (velocity !== undefined) {
      this.channels.setSpeed("x", velocity.x);
      this.channels.setSpeed("y", velocity.y);
    }
    this.paint();
  }

  /** Stops the body and hands the element back to its stylesheet. */
  clear(): void {
    stopMoving(this);
    this.channels.reset();
    this.waitMilliseconds = 0;
    this.delayed = null;
    this.onRest = null;
    this.isLifted = false;
    this.isUnderway = false;
    const { style, classList } = this.element;
    style.transform = "";
    style.opacity = "";
    style.removeProperty("--lift");
    classList.remove(MOVING_CLASS, RISING_CLASS);
  }

  /** Moves the body forward for the clock. Returns true when it is at rest. */
  advance(seconds: number): boolean {
    if (this.waitMilliseconds > 0) {
      this.waitMilliseconds -= seconds * 1000;
      if (this.waitMilliseconds > 0) return false;
      if (this.delayed !== null) {
        this.channels.aim(this.delayed.goal, this.delayed.spring);
        this.delayed = null;
      }
    }
    const atRest = this.channels.advance(seconds);
    this.paint();
    return atRest;
  }

  /** Called by the clock when the body is at rest: gives the element's `will-change` back and runs `done`. */
  rest(): void {
    this.isUnderway = false;
    this.element.classList.remove(MOVING_CLASS, RISING_CLASS);
    const done = this.onRest;
    this.onRest = null;
    done?.();
  }

  private paint(): void {
    const { x, y, s, r, o, l } = this.channels.values;
    const { style } = this.element;
    const isMoved = x !== 0 || y !== 0 || s !== 1 || r !== 0;
    style.transform = isMoved
      ? `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0) scale(${s.toFixed(4)}) rotate(${r.toFixed(3)}deg)`
      : "";
    style.opacity = o === 1 ? "" : o.toFixed(3);
    if (l !== 0 || this.isLifted) {
      style.setProperty("--lift", l.toFixed(3));
      this.isLifted = l !== 0;
    }
  }
}

const bodies = new WeakMap<HTMLElement, MotionBody>();

/** Returns the body of `element`, making it on first use. One element has one body, so every caller moves the same one. */
export const trackBody = (element: HTMLElement): MotionBody => {
  let body = bodies.get(element);
  if (body === undefined) {
    body = new MotionBody(element);
    bodies.set(element, body);
  }
  return body;
};

/** Returns the body of `element` if it ever had one, and never makes one. */
export const findBody = (element: HTMLElement): MotionBody | undefined => bodies.get(element);
