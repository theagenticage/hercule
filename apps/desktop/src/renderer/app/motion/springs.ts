/**
 * The springs everything on the Work board moves on, and the numbers that
 * integrate them. A spring here is a damped oscillator at mass 1, so a spring
 * is told apart by its stiffness and its damping alone.
 */

/** A damped spring at mass 1. */
export interface Spring {
  readonly stiffness: number;
  readonly damping: number;
}

/**
 * The three springs, named for who caused the movement. Overshoot is never
 * built in: a thing overshoots only when it lands with the speed of the hand
 * that threw it, because a landing starts with that speed.
 *
 * - `hand`: under the pointer, or answering it at once (damping ratio 0.86).
 * - `travel`: crossing the screen because the user asked (0.89).
 * - `self`: moving by itself, slow and unhurried (1.00).
 */
export const SPRINGS = {
  hand: { stiffness: 632, damping: 43 },
  travel: { stiffness: 305, damping: 31 },
  self: { stiffness: 90, damping: 19 },
} as const satisfies Record<string, Spring>;

/** The name of one of the three springs. */
export type SpringName = keyof typeof SPRINGS;

/**
 * What a body can animate: `x` and `y` in pixels, `s` the scale, `r` the tilt
 * in degrees, `o` the opacity, and `l` the lift from 0 to 1, which a card's
 * stylesheet reads as `--lift`.
 */
export type Channel = "x" | "y" | "s" | "r" | "o" | "l";

/** One number for every channel. */
export type ChannelValues = Readonly<Record<Channel, number>>;

/** Some of the channels. */
export type PartialChannelValues = Partial<ChannelValues>;

/** Where every channel sits when nothing is applied. */
export const RESTING_VALUES: ChannelValues = { x: 0, y: 0, s: 1, r: 0, o: 1, l: 0 };

const CHANNELS = ["x", "y", "s", "r", "o", "l"] as const;

/** The longest step the integrator takes in one go, in seconds. Smaller keeps the stiffest spring stable. */
const LONGEST_SUBSTEP = 0.004;

/** How close to its goal each channel must be, with how little speed, to count as at rest. */
export type Tolerance = Readonly<Record<Channel, number>>;

/** The tolerance of a body: sub-pixel for positions, and fine enough that a scale or an opacity shows no last-frame jump. */
export const BODY_TOLERANCE: Tolerance = {
  x: 0.08,
  y: 0.08,
  s: 0.0006,
  r: 0.02,
  o: 0.004,
  l: 0.004,
};

/**
 * A channel at rest also needs its speed below this many times the tolerance,
 * so a thing that merely passes through its goal is not cut short.
 */
const REST_SPEED_PER_TOLERANCE = 12;

/** The value, speed, goal and spring of each channel, and the integration that moves them. */
export class SpringChannels {
  readonly values: Record<Channel, number> = { ...RESTING_VALUES };
  readonly goals: Record<Channel, number> = { ...RESTING_VALUES };
  private readonly speeds: Record<Channel, number> = { x: 0, y: 0, s: 0, r: 0, o: 0, l: 0 };
  private readonly springs: Record<Channel, Spring> = {
    x: SPRINGS.hand,
    y: SPRINGS.hand,
    s: SPRINGS.hand,
    r: SPRINGS.hand,
    o: SPRINGS.hand,
    l: SPRINGS.hand,
  };

  constructor(private readonly tolerance: Tolerance) {}

  /** Sends the given channels to new goals on `spring`, keeping the position and speed they have. */
  aim(goals: PartialChannelValues, spring: Spring): void {
    for (const channel of CHANNELS) {
      const goal = goals[channel];
      if (goal === undefined) continue;
      this.goals[channel] = goal;
      this.springs[channel] = spring;
    }
  }

  /** Puts the given channels exactly at these values, at rest. */
  jump(values: PartialChannelValues): void {
    for (const channel of CHANNELS) {
      const value = values[channel];
      if (value === undefined) continue;
      this.values[channel] = value;
      this.goals[channel] = value;
      this.speeds[channel] = 0;
    }
  }

  /** Puts a channel at `value` and leaves its speed and goal alone, so the next steps carry on with the motion it had. */
  relocate(channel: Channel, value: number): void {
    this.values[channel] = value;
  }

  /** Puts every channel back at rest, with no speed. */
  reset(): void {
    this.jump(RESTING_VALUES);
  }

  /**
   * Moves every channel `seconds` forward, in steps small enough to stay
   * stable. Returns true when every channel is at rest on its goal, and has
   * been put exactly there.
   */
  advance(seconds: number): boolean {
    const steps = Math.max(1, Math.ceil(seconds / LONGEST_SUBSTEP));
    const step = seconds / steps;
    let atRest = true;
    for (const channel of CHANNELS) {
      const { stiffness, damping } = this.springs[channel];
      const goal = this.goals[channel];
      let value = this.values[channel];
      let speed = this.speeds[channel];
      for (let n = 0; n < steps; n++) {
        speed += (-stiffness * (value - goal) - damping * speed) * step;
        value += speed * step;
      }
      const tolerance = this.tolerance[channel];
      if (
        Math.abs(value - goal) < tolerance &&
        Math.abs(speed) < tolerance * REST_SPEED_PER_TOLERANCE
      ) {
        value = goal;
        speed = 0;
      } else {
        atRest = false;
      }
      this.values[channel] = value;
      this.speeds[channel] = speed;
    }
    return atRest;
  }
}
