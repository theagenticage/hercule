import type { Shape } from "./look";

/**
 * The measurements of a body shape, in the units of the face's viewBox. Every
 * shape is an egg centred on x 24.
 */
interface ShapeMetrics {
  /** The y of the top of the head. */
  readonly topY: number;
  /** The y of the base. */
  readonly bottomY: number;
  /** The y of the widest point. It sits below the middle, so the body sits firmly on its base. */
  readonly widestY: number;
  /** Half the body's width at its widest point. */
  readonly halfWidth: number;
}

/** The measurements of each body shape, as in the Bureau book's crew.js. */
export const SHAPE_METRICS: Readonly<Record<Shape, ShapeMetrics>> = {
  egg: { topY: 9.6, bottomY: 42.4, widestY: 30.5, halfWidth: 14.4 },
  tall: { topY: 8.4, bottomY: 42.4, widestY: 31, halfWidth: 12.8 },
  round: { topY: 11, bottomY: 42.4, widestY: 29.5, halfWidth: 15.4 },
  wide: { topY: 12.6, bottomY: 42.4, widestY: 31, halfWidth: 16.2 },
};

/**
 * Rounds a coordinate to two decimals, as crew.js rounds the numbers it writes
 * into a path.
 */
export function roundToHundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Builds the SVG path of a body shape: an egg outline from the shape's top,
 * bottom, widest height and half-width. The numbers are computed exactly as
 * the Bureau book's crew.js computes them: the same values are rounded to two
 * decimals and the same values are left unrounded. That is why the wide
 * shape's left edge is 7.800000000000001 and not 7.8. It is not a bug: the
 * path equals the book's string, so the tests can pin the book's own output
 * and the pixel comparison has no rounding difference to explain.
 */
export function buildBodyPath(shape: Shape): string {
  const { topY, bottomY, widestY, halfWidth } = SHAPE_METRICS[shape];
  const up = widestY - topY;
  const down = bottomY - widestY;
  // The x of the widest point on each side, left unrounded as crew.js leaves it.
  const right = 24 + halfWidth;
  const left = 24 - halfWidth;
  const top = roundToHundredths(topY);
  const bottom = roundToHundredths(bottomY);
  const widest = roundToHundredths(widestY);
  // The curves' control points, rounded as crew.js rounds them.
  const upperControlY = roundToHundredths(widestY - up * 0.52);
  const lowerControlY = roundToHundredths(widestY + down * 0.62);
  const topRightControlX = roundToHundredths(24 + halfWidth * 0.6);
  const topLeftControlX = roundToHundredths(24 - halfWidth * 0.6);
  const bottomRightControlX = roundToHundredths(24 + halfWidth * 0.7);
  const bottomLeftControlX = roundToHundredths(24 - halfWidth * 0.7);
  // Four curves, clockwise from the top: the upper right, the lower right,
  // the lower left and the upper left quarter.
  return (
    `M24 ${top}` +
    `C${topRightControlX} ${top} ${right} ${upperControlY} ${right} ${widest}` +
    `C${right} ${lowerControlY} ${bottomRightControlX} ${bottom} 24 ${bottom}` +
    `C${bottomLeftControlX} ${bottom} ${left} ${lowerControlY} ${left} ${widest}` +
    `C${left} ${upperControlY} ${topLeftControlX} ${top} 24 ${top}Z`
  );
}
