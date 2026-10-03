/**
 * PROTOTYPE - the measurements of a colleague's body, in metres, for both
 * character styles and all four body shapes.
 *
 * The egg a colleague is drawn as comes straight from the Bureau's 2D face:
 * `SHAPE_METRICS` gives each shape's top, bottom, widest point and half
 * width, and the outline is the same pair of cubic curves `buildBodyPath`
 * draws. A `bean` is that egg as its whole body, on short legs. A `suited`
 * colleague wears the egg as its head, on a grown-up body in a suit.
 *
 * Face features are placed in the 2D face's own units (x 24 is the middle,
 * y 42.4 the bottom of every egg) and mapped onto the egg's surface, so the
 * 3D face keeps the book's proportions.
 */
import { Vector3 } from "three";
import type { CharacterStyle } from "../../engine/contracts";
import type { Shape } from "../../../faces/look";
import { SHAPE_METRICS } from "../../../faces/shapes";

/** The y of the bottom of every egg in the 2D face's units. */
const FACE_BOTTOM = 42.4;
/** The x of the middle of every egg in the 2D face's units. */
const FACE_MIDDLE = 24;

/** A lathed egg: its outline from bottom to top, and how it maps the 2D face onto itself. */
export interface Egg {
  /** The height of the egg from its bottom to its top. */
  readonly height: number;
  /** The height of the egg's widest point above its bottom. */
  readonly widestHeight: number;
  /** Half the egg's width at its widest point. */
  readonly halfWidth: number;
  /** The egg's depth as a fraction of its width: below 1 it is a little flattened front to back. */
  readonly depth: number;
  /** Metres per unit of the 2D face, vertically. */
  readonly unit: number;
  /** Metres per unit of the 2D face, across. Narrower than `unit` when the egg is slimmed. */
  readonly unitAcross: number;
  /** The outline as [radius, height] pairs, from the bottom to the top. */
  readonly outline: ReadonlyArray<readonly [number, number]>;
}

/** Evaluates one coordinate of a cubic Bezier curve at `t`. */
function evaluateCubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/**
 * Builds the egg of `shape`: `height` metres from bottom to top, slimmed to
 * `slim` of the 2D width and flattened front to back to `depth` of its width.
 */
function buildEgg(shape: Shape, height: number, slim: number, depth: number): Egg {
  const { topY, bottomY, widestY, halfWidth } = SHAPE_METRICS[shape];
  const unit = height / (bottomY - topY);
  const unitAcross = unit * slim;
  const up = widestY - topY;
  const down = bottomY - widestY;
  const right = halfWidth;
  const outline: Array<readonly [number, number]> = [];
  const steps = 10;
  // The lower right curve, walked from the bottom up to the widest point.
  for (let i = 0; i <= steps; i++) {
    const t = 1 - i / steps;
    const x = evaluateCubic(right, right, halfWidth * 0.7, 0, t);
    const y = evaluateCubic(widestY, widestY + down * 0.62, bottomY, bottomY, t);
    outline.push([x * unitAcross, (bottomY - y) * unit]);
  }
  // The upper right curve, walked from the widest point up to the top.
  for (let i = steps - 1; i >= 0; i--) {
    const t = i / steps;
    const x = evaluateCubic(0, halfWidth * 0.6, right, right, t);
    const y = evaluateCubic(topY, topY, widestY - up * 0.52, widestY, t);
    outline.push([x * unitAcross, (bottomY - y) * unit]);
  }
  return {
    height,
    widestHeight: (bottomY - widestY) * unit,
    halfWidth: halfWidth * unitAcross,
    depth,
    unit,
    unitAcross,
    outline,
  };
}

/** Returns the egg's radius across (x) at `height` above its bottom, or 0 above or below the egg. */
export function measureEggRadius(egg: Egg, height: number): number {
  const { outline } = egg;
  if (height <= 0 || height >= egg.height) return 0;
  for (let i = 1; i < outline.length; i++) {
    const [r1, h1] = outline[i]!;
    if (h1 >= height) {
      const [r0, h0] = outline[i - 1]!;
      const t = h1 === h0 ? 0 : (height - h0) / (h1 - h0);
      return r0 + (r1 - r0) * t;
    }
  }
  return 0;
}

/**
 * Converts a point of the 2D face to the egg's own space: x across, y up from
 * the egg's bottom. Returns `out`.
 */
export function mapFacePoint(egg: Egg, faceX: number, faceY: number, out: Vector3): Vector3 {
  return out.set((faceX - FACE_MIDDLE) * egg.unitAcross, (FACE_BOTTOM - faceY) * egg.unit, 0);
}

/**
 * Places a point on the front of the egg at `x` across and `y` up, `lift`
 * metres out along the surface's normal. Writes the point to `out` and the
 * normal to `normal`. A point beyond the egg's side is pulled in onto it.
 */
export function placeOnEgg(
  egg: Egg,
  x: number,
  y: number,
  lift: number,
  out: Vector3,
  normal: Vector3,
): Vector3 {
  const radius = Math.max(measureEggRadius(egg, y), 1e-4);
  const across = Math.max(-radius * 0.995, Math.min(radius * 0.995, x));
  const z = egg.depth * Math.sqrt(radius * radius - across * across);
  const slope = (measureEggRadius(egg, y + 0.004) - measureEggRadius(egg, y - 0.004)) / 0.008;
  normal.set(across, -radius * slope, z / (egg.depth * egg.depth)).normalize();
  return out.set(across, y, z).addScaledVector(normal, lift);
}

/** A joint's place, in its parent's space. */
export interface Place {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Everything that sizes a colleague's body. All lengths are in metres. */
export interface Anatomy {
  readonly style: CharacterStyle;
  readonly shape: Shape;
  /** The egg with the face on it: a bean's whole body, a suited colleague's head. */
  readonly egg: Egg;
  /** A suited colleague's jacket, lathed like the egg; null for a bean. */
  readonly jacket: Egg | null;
  /** The height of the pelvis above the floor when standing. */
  readonly standingPelvis: number;
  /** The height of the pelvis above the seat's top when sitting. */
  readonly seatedPelvis: number;
  /** The hip joint, in the pelvis's space, for the left leg (+x); the right one mirrors it. */
  readonly hip: Place;
  readonly thigh: number;
  readonly shin: number;
  readonly legRadius: number;
  /** The height of the ankle above the sole. */
  readonly ankle: number;
  /** The shoulder joint, in the torso's space, for the left arm (+x). */
  readonly shoulder: Place;
  readonly upperArm: number;
  readonly forearm: number;
  readonly armRadius: number;
  readonly handRadius: number;
  /** The head's pivot in the torso's space. A bean's head is its body, so its pivot is the origin. */
  readonly neck: Place;
  /** The radius of the face's strokes: brows, mouths, closed eyes. */
  readonly stroke: number;
}

/** The suited style's head height, per shape, so the shapes keep their 2D height ratios. */
const SUITED_HEAD = 0.3 / (SHAPE_METRICS.egg.bottomY - SHAPE_METRICS.egg.topY);
/** The bean style's body height per 2D unit: the egg shape's body is 0.8 tall. */
const BEAN_BODY = 0.8 / (SHAPE_METRICS.egg.bottomY - SHAPE_METRICS.egg.topY);

/** How wide each shape's suit is cut, against the egg shape's. */
const SUIT_WIDTH: Readonly<Record<Shape, number>> = { egg: 1, tall: 0.9, round: 1.08, wide: 1.16 };

/** Builds the anatomy of a bean: the Bureau's egg as a whole body on short legs. */
function buildBeanAnatomy(shape: Shape): Anatomy {
  const metrics = SHAPE_METRICS[shape];
  const egg = buildEgg(shape, (metrics.bottomY - metrics.topY) * BEAN_BODY, 0.84, 0.8);
  const shoulderHeight = egg.widestHeight + 0.035;
  const shoulderRadius = measureEggRadius(egg, shoulderHeight);
  return {
    style: "bean",
    shape,
    egg,
    jacket: null,
    standingPelvis: 0.2,
    seatedPelvis: 0.004,
    hip: { x: Math.min(0.095, egg.halfWidth * 0.34), y: 0.055, z: 0.01 },
    thigh: 0.11,
    shin: 0.11,
    legRadius: 0.043,
    ankle: 0.05,
    shoulder: { x: shoulderRadius - 0.035, y: shoulderHeight, z: 0.035 },
    upperArm: 0.14,
    forearm: 0.13,
    armRadius: 0.036,
    handRadius: 0.047,
    neck: { x: 0, y: 0, z: 0 },
    stroke: 0.62 * egg.unit,
  };
}

/** Builds the anatomy of a suited colleague: the egg as a head on a body in a suit. */
function buildSuitedAnatomy(shape: Shape): Anatomy {
  const metrics = SHAPE_METRICS[shape];
  const egg = buildEgg(shape, (metrics.bottomY - metrics.topY) * SUITED_HEAD, 0.94, 0.9);
  const jacket = buildEgg("egg", 0.4, 0.84 * SUIT_WIDTH[shape], 0.72);
  const shoulderHeight = 0.315;
  return {
    style: "suited",
    shape,
    egg,
    jacket,
    standingPelvis: 0.33,
    seatedPelvis: 0.012,
    hip: { x: 0.078 * Math.min(1.1, SUIT_WIDTH[shape]), y: 0.05, z: 0 },
    thigh: 0.18,
    shin: 0.175,
    legRadius: 0.05,
    ankle: 0.05,
    shoulder: {
      x: measureEggRadius(jacket, shoulderHeight) - 0.01,
      y: shoulderHeight,
      z: 0.0,
    },
    upperArm: 0.165,
    forearm: 0.155,
    armRadius: 0.04,
    handRadius: 0.043,
    neck: { x: 0, y: 0.375, z: 0.005 },
    stroke: 0.62 * egg.unit,
  };
}

const anatomies = new Map<string, Anatomy>();

/** Returns the anatomy of `style` and `shape`, built once and then shared. */
export function readAnatomy(style: CharacterStyle, shape: Shape): Anatomy {
  const key = `${style}|${shape}`;
  let anatomy = anatomies.get(key);
  if (anatomy === undefined) {
    anatomy = style === "bean" ? buildBeanAnatomy(shape) : buildSuitedAnatomy(shape);
    anatomies.set(key, anatomy);
  }
  return anatomy;
}

/** Returns the height of the top of the egg above the floor when the colleague stands. */
export function measureStandingHeight(anatomy: Anatomy): number {
  return anatomy.standingPelvis + anatomy.neck.y + anatomy.egg.height;
}
