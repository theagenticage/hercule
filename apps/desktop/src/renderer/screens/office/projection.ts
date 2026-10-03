/**
 * The geometry of the Office: how a point in the room's floor plan lands on
 * the screen. Ported from the Bureau book's office.js.
 *
 * Plan coordinates: x runs along the right-hand back wall, y along the
 * left-hand back wall, and z is height. One unit is one floor tile. The view
 * is isometric: a step along x moves right and down on the screen, a step
 * along y moves left and down, and a step up z moves straight up.
 *
 * The book formats every number it writes into the drawing with a fixed
 * number of decimals. The port formats them the same way, so the two
 * drawings match to the pixel.
 */

/** The room's length along x, in tiles. */
export const ROOM_WIDTH = 24;
/** The room's length along y, in tiles. */
export const ROOM_DEPTH = 18.6;
/** The height of the walls, in tiles. */
export const WALL_HEIGHT = 3.2;

/** cos 30°: how far one tile along x or y moves a point across the screen, per tile of size. */
const COS_30 = 0.8660254;

/**
 * How the room is drawn on a stage: the size of one floor tile in pixels and
 * where the plan's origin, the back corner of the floor, lands.
 */
export interface Projection {
  /** The size of one floor tile, in pixels. */
  readonly tile: number;
  /** The x of the plan's origin on the stage, in pixels. */
  readonly originX: number;
  /** The y of the plan's origin on the stage, in pixels. */
  readonly originY: number;
}

/** A rectangle of the floor plan, in tiles. */
export interface PlanRegion {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

/** A point on the stage, in pixels: `[x, y]`. */
export type StagePoint = readonly [number, number];

/** Returns the stage point that the plan point `(x, y, z)` lands on under `projection`. */
export function projectPoint(projection: Projection, x: number, y: number, z = 0): StagePoint {
  const { tile, originX, originY } = projection;
  const across = tile * COS_30;
  const down = tile * 0.5;
  return [originX + (x - y) * across, originY + (x + y) * down - z * tile];
}

/**
 * Returns the projection that fits the plan region `region`, from the floor
 * to just above the top of the walls, into a stage `width` by `height`
 * pixels, with `pad` pixels to spare on every side. The region is centred on
 * the stage, and one tile is never larger than `maxTile` pixels.
 */
export function frameRegion(
  width: number,
  height: number,
  region: PlanRegion,
  pad: number,
  maxTile: number,
): Projection {
  // The region's corners on the floor and above the walls, in units of one tile.
  const corners: StagePoint[] = [];
  for (const x of [region.x0, region.x1]) {
    for (const y of [region.y0, region.y1]) {
      corners.push(
        [(x - y) * COS_30, (x + y) * 0.5],
        [(x - y) * COS_30, (x + y) * 0.5 - WALL_HEIGHT - 0.6],
      );
    }
  }
  const xs = corners.map((corner) => corner[0]);
  const ys = corners.map((corner) => corner[1]);
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  const tile = Math.min(
    maxTile,
    (width - pad * 2) / (right - left),
    (height - pad * 2) / (bottom - top),
  );
  return {
    tile,
    originX: width / 2 - (tile * (left + right)) / 2,
    originY: height / 2 - (tile * (top + bottom)) / 2,
  };
}

/** Formats `value` with one decimal, as the book writes every coordinate. */
export const formatTenths = (value: number): string => value.toFixed(1);

/** Formats a list of stage points as an SVG `points` attribute: `"x,y x,y"`, one decimal each. */
export const formatPoints = (list: ReadonlyArray<StagePoint>): string =>
  list.map((point) => `${formatTenths(point[0])},${formatTenths(point[1])}`).join(" ");

/** Rounds `value` to three decimals, as the book writes the numbers of a matrix. */
const roundToThousandths = (value: number): number => Number(value.toFixed(3));

/**
 * Builds an SVG `matrix(...)` transform from its six numbers, each rounded to
 * three decimals. `origin` is the translation, a stage point.
 */
export function buildMatrix(
  a: number,
  b: number,
  c: number,
  d: number,
  origin: StagePoint,
): string {
  return `matrix(${[a, b, c, d, origin[0], origin[1]].map(roundToThousandths).join(" ")})`;
}

/**
 * Returns the transform that lays a flat drawing on the floor with its top-left
 * corner at plan point `(x, y)`. One tile is `tile` pixels of the drawing.
 */
export function placeOnFloor(projection: Projection, x: number, y: number): string {
  const { across, down } = measureSteps(projection);
  return buildMatrix(across, down, -across, down, projectPoint(projection, x, y, 0));
}

/**
 * Returns the transform that hangs a flat drawing on the right-hand back wall,
 * the plane y = `yPlane` seen from +y, with its top-left corner at `(x, z)`.
 * The drawing's x runs along +x and its y runs down.
 */
export function placeOnBackWall(
  projection: Projection,
  x: number,
  yPlane: number,
  z: number,
): string {
  const { across, down } = measureSteps(projection);
  return buildMatrix(across, down, 0, 1, projectPoint(projection, x, yPlane, z));
}

/**
 * Returns the transform that hangs a flat drawing on the left-hand back wall,
 * the plane x = `xPlane` seen from +x, with its top-left corner at `(y, z)`.
 * The drawing's x runs along -y, so text on it reads left to right.
 */
export function placeOnSideWall(
  projection: Projection,
  xPlane: number,
  y: number,
  z: number,
): string {
  const { across, down } = measureSteps(projection);
  return buildMatrix(across, -down, 0, 1, projectPoint(projection, xPlane, y, z));
}

/**
 * Returns how far one pixel of a flat drawing moves across and down the stage
 * when the drawing lies in the room. Computed as the book computes it, so the
 * rounded matrix numbers match.
 */
function measureSteps(projection: Projection): { readonly across: number; readonly down: number } {
  const { tile } = projection;
  return { across: (tile * COS_30) / tile, down: (tile * 0.5) / tile };
}
