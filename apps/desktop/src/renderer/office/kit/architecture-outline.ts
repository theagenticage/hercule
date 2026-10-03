/**
 * PROTOTYPE - traces text drawn on a canvas into outlines, so lettering can
 * be built as real geometry. A browser draws a font but never hands out its
 * glyph outlines, so the kit draws the text and follows the edge of its ink.
 */
import { Path, Shape, Vector2 } from "three";

/** The most a simplified outline may stray from the traced one, in canvas pixels. */
const TOLERANCE = 0.3;
/** Outlines that enclose less than this many square pixels are specks of anti-aliasing. */
const SMALLEST_AREA = 6;

/**
 * Traces the ink of `image` into shapes: one `Shape` per outline, with the
 * outlines inside it as holes. A pixel is ink where its alpha is at least
 * half, and the outline runs between pixels by their alpha, so it is smooth
 * rather than stepped. `toPoint` converts a canvas position, in pixels, to
 * the shape's units. Returns an empty list when the image has no ink.
 */
export function traceShapes(image: ImageData, toPoint: (x: number, y: number) => Vector2): Shape[] {
  const loops = traceLoops(image)
    .map((loop) => simplifyLoop(loop, TOLERANCE))
    .filter((loop) => Math.abs(measureArea(loop)) >= SMALLEST_AREA);
  const areas = loops.map((loop) => Math.abs(measureArea(loop)));
  // Outlines never cross, so how many others enclose an outline tells whether
  // it is ink (an even count) or a hole in the ink (an odd one).
  const enclosing = loops.map((loop, index) =>
    loops
      .map((_, other) => other)
      .filter((other) => other !== index && encloses(loops[other]!, loop[0]!, loop[1]!)),
  );
  const shapes = new Map<number, Shape>();
  const toPoints = (loop: number[]) => {
    const points: Vector2[] = [];
    for (let at = 0; at < loop.length; at += 2) points.push(toPoint(loop[at]!, loop[at + 1]!));
    return points;
  };
  loops.forEach((loop, index) => {
    if (enclosing[index]!.length % 2 === 0) shapes.set(index, new Shape(toPoints(loop)));
  });
  loops.forEach((loop, index) => {
    const parents = enclosing[index]!;
    if (parents.length % 2 === 0) return;
    // A hole belongs to the smallest outline round it.
    const parent = parents.reduce((best, other) => (areas[other]! < areas[best]! ? other : best));
    shapes.get(parent)?.holes.push(new Path(toPoints(loop)));
  });
  return [...shapes.values()];
}

/**
 * Follows the half-alpha edge through `image` by marching squares and returns
 * every closed outline as a flat list of x, y pixel positions. The image is
 * treated as clear beyond its border, so every outline closes.
 */
function traceLoops(image: ImageData): number[][] {
  // The alpha of each pixel, inside a one-pixel border of clear pixels.
  const width = image.width + 2;
  const height = image.height + 2;
  const alpha = new Float32Array(width * height);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      alpha[(y + 1) * width + x + 1] = image.data[(y * image.width + x) * 4 + 3]! / 255;
    }
  }
  // An edge between two neighbouring pixels has an id: even when it runs to
  // the right of a pixel, odd when it runs down.
  const across = (x: number, y: number) => (y * width + x) * 2;
  const down = (x: number, y: number) => (y * width + x) * 2 + 1;
  const ends: number[] = [];
  const touching = new Map<number, number[]>();
  const join = (from: number, to: number) => {
    const segment = ends.length / 2;
    ends.push(from, to);
    for (const edge of [from, to]) {
      const list = touching.get(edge);
      if (list === undefined) touching.set(edge, [segment]);
      else list.push(segment);
    }
  };
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const topLeft = alpha[y * width + x]!;
      const topRight = alpha[y * width + x + 1]!;
      const bottomRight = alpha[(y + 1) * width + x + 1]!;
      const bottomLeft = alpha[(y + 1) * width + x]!;
      const kind =
        (topLeft >= 0.5 ? 8 : 0) |
        (topRight >= 0.5 ? 4 : 0) |
        (bottomRight >= 0.5 ? 2 : 0) |
        (bottomLeft >= 0.5 ? 1 : 0);
      if (kind === 0 || kind === 15) continue;
      const top = across(x, y);
      const bottom = across(x, y + 1);
      const left = down(x, y);
      const right = down(x + 1, y);
      // Where two opposite corners are ink, the cell's centre decides whether they join.
      const joined = (topLeft + topRight + bottomRight + bottomLeft) / 4 >= 0.5;
      switch (kind) {
        case 1:
        case 14:
          join(left, bottom);
          break;
        case 2:
        case 13:
          join(bottom, right);
          break;
        case 3:
        case 12:
          join(left, right);
          break;
        case 4:
        case 11:
          join(top, right);
          break;
        case 6:
        case 9:
          join(top, bottom);
          break;
        case 7:
        case 8:
          join(left, top);
          break;
        case 5:
          // The top right and the bottom left are ink.
          if (joined) {
            join(left, top);
            join(bottom, right);
          } else {
            join(top, right);
            join(left, bottom);
          }
          break;
        case 10:
          // The top left and the bottom right are ink.
          if (joined) {
            join(top, right);
            join(left, bottom);
          } else {
            join(left, top);
            join(bottom, right);
          }
          break;
      }
    }
  }
  // Each edge the outline crosses is shared by exactly two segments; walking
  // from segment to segment through them closes each outline.
  const crossing = (edge: number): [number, number] => {
    const cell = edge >> 1;
    const x = cell % width;
    const y = (cell - x) / width;
    const [toX, toY] = edge % 2 === 0 ? [x + 1, y] : [x, y + 1];
    const from = alpha[cell]!;
    const share = (0.5 - from) / (alpha[toY * width + toX]! - from);
    // A padded pixel's centre is half a pixel before its index, on the canvas.
    return [x + (toX - x) * share - 0.5, y + (toY - y) * share - 0.5];
  };
  const walked = new Uint8Array(ends.length / 2);
  const loops: number[][] = [];
  for (let first = 0; first < walked.length; first++) {
    if (walked[first] === 1) continue;
    const loop: number[] = [];
    let segment = first;
    let from = ends[first * 2]!;
    do {
      walked[segment] = 1;
      const to = ends[segment * 2] === from ? ends[segment * 2 + 1]! : ends[segment * 2]!;
      loop.push(...crossing(to));
      const pair = touching.get(to)!;
      segment = pair[0] === segment ? pair[1]! : pair[0]!;
      from = to;
    } while (segment !== first);
    loops.push(loop);
  }
  return loops;
}

/**
 * Returns `loop` with the points dropped that lie within `tolerance` of the
 * line through their neighbours (Douglas-Peucker), so a straight stroke keeps
 * two points and a curve keeps only as many as its bend needs.
 */
function simplifyLoop(loop: number[], tolerance: number): number[] {
  const count = loop.length / 2;
  if (count < 4) return loop;
  const pointX = (index: number) => loop[(index % count) * 2]!;
  const pointY = (index: number) => loop[(index % count) * 2 + 1]!;
  // A closed loop is cut into two open halves at its first point and the point farthest from it.
  let farthest = 0;
  let farthestDistance = -1;
  for (let index = 1; index < count; index++) {
    const distance = Math.hypot(pointX(index) - pointX(0), pointY(index) - pointY(0));
    if (distance > farthestDistance) {
      farthest = index;
      farthestDistance = distance;
    }
  }
  const kept = new Uint8Array(count);
  kept[0] = 1;
  kept[farthest] = 1;
  const pending: Array<[number, number]> = [
    [0, farthest],
    [farthest, count],
  ];
  while (pending.length > 0) {
    const [from, to] = pending.pop()!;
    const ax = pointX(from);
    const ay = pointY(from);
    const dx = pointX(to) - ax;
    const dy = pointY(to) - ay;
    const length = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let worstDistance = tolerance;
    for (let index = from + 1; index < to; index++) {
      const distance = Math.abs((pointX(index) - ax) * dy - (pointY(index) - ay) * dx) / length;
      if (distance > worstDistance) {
        worst = index;
        worstDistance = distance;
      }
    }
    if (worst === -1) continue;
    kept[worst] = 1;
    pending.push([from, worst], [worst, to]);
  }
  const simplified: number[] = [];
  for (let index = 0; index < count; index++) {
    if (kept[index] === 1) simplified.push(pointX(index), pointY(index));
  }
  return simplified;
}

/** Returns the signed area a loop of flat x, y positions encloses. */
function measureArea(loop: number[]): number {
  let twice = 0;
  for (let at = 0; at < loop.length; at += 2) {
    const next = (at + 2) % loop.length;
    twice += loop[at]! * loop[next + 1]! - loop[next]! * loop[at + 1]!;
  }
  return twice / 2;
}

/** Checks whether the loop of flat x, y positions encloses the point (`x`, `y`). */
function encloses(loop: number[], x: number, y: number): boolean {
  let inside = false;
  for (let at = 0, before = loop.length - 2; at < loop.length; before = at, at += 2) {
    const ax = loop[at]!;
    const ay = loop[at + 1]!;
    const bx = loop[before]!;
    const by = loop[before + 1]!;
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}
