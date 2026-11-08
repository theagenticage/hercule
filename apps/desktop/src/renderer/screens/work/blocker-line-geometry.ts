/**
 * The geometry of the line from a blocked card to the card that blocks it. The
 * line keeps to the gaps between cards, so it never runs through anyone's
 * words. It is the drawing's route, kept as pure functions so a test can pin
 * it: no function here touches the page.
 */

/** A rectangle's four edges, in the same coordinate space as the points of a route. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** A point on the board, as `[x, y]`. */
export type Point = readonly [number, number];

/** How far the first run of the line stands from the blocked card's edge, in the gap between two rows. */
const ROW_GAP_OFFSET = 11;

/** How far the last upright run stands from the blocker's side, in the gutter between two columns. */
const GUTTER_OFFSET = 7;

/** How far a corner of the line is rounded. */
export const LINE_CORNER_RADIUS = 6;

/** How far past an edge a box still counts as beside, not over, another box. */
const SIDE_TOLERANCE = 1;

/**
 * Returns the corners of the line from `from` (the blocked card) to `to` (the
 * card that blocks it), in the order the line is drawn. The last point is
 * where the line ends, on the side of `to` that faces `from`, at half its
 * height.
 *
 * The route has four runs:
 *
 * 1. from the middle of the blocked card's bottom edge (its top edge when the
 *    blocker is not lower) into the gap between rows;
 * 2. along that gap, to the gutter beside the blocker;
 * 3. up or down that gutter, to the blocker's half height;
 * 4. in at the blocker's side.
 *
 * The blocker's right side is used when it lies wholly to the left of the
 * blocked card. In every other case its left side is, which includes a
 * blocker in the same column.
 */
export const routeBlockerLine = (from: Box, to: Box): readonly Point[] => {
  const goesLeft = to.right <= from.left + SIDE_TOLERANCE;
  const isBelow = to.top > from.bottom;
  const startX = from.left + (from.right - from.left) / 2;
  const startY = isBelow ? from.bottom : from.top;
  const rowY = startY + (isBelow ? ROW_GAP_OFFSET : -ROW_GAP_OFFSET);
  const gutterX = goesLeft ? to.right + GUTTER_OFFSET : to.left - GUTTER_OFFSET;
  const endX = goesLeft ? to.right : to.left;
  const endY = to.top + (to.bottom - to.top) / 2;
  return [
    [startX, startY],
    [startX, rowY],
    [gutterX, rowY],
    [gutterX, endY],
    [endX, endY],
  ];
};

/** Returns `value` rounded to two decimals, so a path stays short and a test reads it. */
const trim = (value: number): number => Math.round(value * 100) / 100;

/**
 * Returns the SVG path data through `points`, with each corner (every point
 * but the first and the last) rounded by up to `radius`. A corner next to a
 * short run rounds by at most half that run, so two rounded corners never
 * overlap. Needs at least two points.
 */
export const buildRoundedPath = (points: readonly Point[], radius: number): string => {
  const [first, ...rest] = points;
  if (first === undefined || rest.length === 0) return "";
  let path = `M${String(trim(first[0]))} ${String(trim(first[1]))}`;
  for (let index = 1; index < points.length - 1; index++) {
    const [px, py] = points[index]!;
    const [ax, ay] = points[index - 1]!;
    const [bx, by] = points[index + 1]!;
    const lengthIn = Math.hypot(px - ax, py - ay) || 1;
    const lengthOut = Math.hypot(bx - px, by - py) || 1;
    const radiusIn = Math.min(radius, lengthIn / 2);
    const radiusOut = Math.min(radius, lengthOut / 2);
    const startX = px + ((ax - px) / lengthIn) * radiusIn;
    const startY = py + ((ay - py) / lengthIn) * radiusIn;
    const endX = px + ((bx - px) / lengthOut) * radiusOut;
    const endY = py + ((by - py) / lengthOut) * radiusOut;
    path += `L${String(trim(startX))} ${String(trim(startY))}Q${String(trim(px))} ${String(trim(py))} ${String(trim(endX))} ${String(trim(endY))}`;
  }
  const [lastX, lastY] = points[points.length - 1]!;
  return `${path}L${String(trim(lastX))} ${String(trim(lastY))}`;
};
