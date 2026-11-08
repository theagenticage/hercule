/**
 * A spring as a CSS easing, or as the keyframes of a push, for the motion that
 * runs as a Web Animation on the compositor and not frame by frame on the
 * clock: the line of a card that rolls over to new words, the knock a card
 * takes. It is the same spring the clock integrates, so a thing moved either
 * way settles alike.
 */
import { SPRINGS, type SpringName } from "./springs";

/** A spring drawn as a CSS `linear()` easing, with the time it takes to settle. */
export interface SpringCurve {
  /** The `linear()` easing, from 0 at the start to 1 at the end. */
  readonly ease: string;
  /** How long the spring takes to settle, in milliseconds. Use it as the animation's duration. */
  readonly ms: number;
}

/** The step of the integration, in seconds. */
const STEP = 1 / 120;

/** The longest the integration runs, in seconds. The slowest spring settles well before it. */
const LONGEST = 2.5;

/** A spring has settled when it stays this close to 1 with less than this speed... */
const CLOSE = 0.0015;
const SLOW = 0.02;

/** ...for more than this many steps in a row. */
const QUIET_STEPS = 6;

/** About how many points the easing keeps. More points do not look smoother. */
const POINTS = 40;

const curves = new Map<SpringName, SpringCurve>();

/**
 * Returns the spring `name` as a `linear()` easing and the time it takes to
 * settle. It integrates `x'' = k (1 - x) - c x'` from rest at 0 towards 1 in
 * steps of 1/120 s, stops once the spring has stayed settled for a few steps
 * (or after 2.5 s), and keeps about 40 evenly spaced points. A spring with
 * damping under 1 passes 1 on its way, so the easing may overshoot, as the
 * spring does. The result is the same each time, so it is made once.
 */
export const buildSpringCurve = (name: SpringName): SpringCurve => {
  const known = curves.get(name);
  if (known !== undefined) return known;
  const { stiffness, damping } = SPRINGS[name];
  const points: number[] = [];
  let x = 0;
  let speed = 0;
  let seconds = 0;
  let quiet = 0;
  while (seconds < LONGEST) {
    speed += (stiffness * (1 - x) - damping * speed) * STEP;
    x += speed * STEP;
    seconds += STEP;
    points.push(x);
    quiet = Math.abs(1 - x) < CLOSE && Math.abs(speed) < SLOW ? quiet + 1 : 0;
    if (quiet > QUIET_STEPS) break;
  }
  const every = Math.max(1, Math.round(points.length / POINTS));
  const kept = ["0"];
  for (let index = every; index < points.length; index += every) {
    kept.push(points[index]!.toFixed(4));
  }
  kept.push("1");
  const curve: SpringCurve = { ease: `linear(${kept.join(", ")})`, ms: Math.round(seconds * 1000) };
  curves.set(name, curve);
  return curve;
};

/** A knock settles when it stays within this many pixels of rest, with less than this many pixels a second. */
const KNOCK_CLOSE = 0.05;
const KNOCK_SLOW = 1;

/** A push on a spring: how far it is from rest at evenly spaced moments, and how long it takes. */
export interface SpringKnock {
  /** The distance from rest at each moment, the first and the last being 0. The unit is that of the speed given. */
  readonly offsets: readonly number[];
  /** How long the knock takes, in milliseconds. Use it as the animation's duration, with a linear easing. */
  readonly ms: number;
}

const knocks = new Map<string, SpringKnock>();

/**
 * Returns what a thing at rest does when it is pushed at `speed` (a unit a
 * second, such as pixels) and its spring `name` brings it back: it moves off,
 * passes back through rest with a little overshoot, and settles. It integrates
 * the same spring as `buildSpringCurve`, from rest at 0 with that speed, and
 * keeps about 40 evenly spaced points. A caller plays them as the keyframes of
 * one Web Animation, so the knock costs the main thread nothing while it runs.
 * The result is the same each time, so it is made once.
 */
export const buildSpringKnock = (name: SpringName, speed: number): SpringKnock => {
  const key = `${name}:${String(speed)}`;
  const known = knocks.get(key);
  if (known !== undefined) return known;
  const { stiffness, damping } = SPRINGS[name];
  const points: number[] = [];
  let x = 0;
  let velocity = speed;
  let seconds = 0;
  let quiet = 0;
  while (seconds < LONGEST) {
    velocity += (-stiffness * x - damping * velocity) * STEP;
    x += velocity * STEP;
    seconds += STEP;
    points.push(x);
    quiet = Math.abs(x) < KNOCK_CLOSE && Math.abs(velocity) < KNOCK_SLOW ? quiet + 1 : 0;
    if (quiet > QUIET_STEPS) break;
  }
  const every = Math.max(1, Math.round(points.length / POINTS));
  const count = Math.ceil(points.length / every);
  const offsets = [0];
  // `points[n - 1]` is the position after `n` steps.
  for (let index = 1; index < count; index++) offsets.push(points[index * every - 1]!);
  offsets.push(0);
  const knock: SpringKnock = { offsets, ms: Math.round(count * every * STEP * 1000) };
  knocks.set(key, knock);
  return knock;
};
