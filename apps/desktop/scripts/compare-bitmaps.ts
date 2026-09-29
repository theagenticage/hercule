/**
 * The pixel comparison behind `pnpm compare:bureau`: pure functions over raw
 * captures, with nothing from Electron, so they can be tested on plain Node.
 *
 * A capture is what Electron's `nativeImage.toBitmap()` returns: four bytes
 * per device pixel, row by row. The byte order is BGRA on a Mac, but the
 * comparison treats the four channels alike, so only `buildDiffBitmap` needs
 * to know which byte is which.
 */

/** A raw capture: `width` × `height` device pixels, four bytes each (BGRA), row by row. */
export interface Bitmap {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** A cell of a sheet: its name and its rectangle on the capture, in device pixels. */
export interface CellRect {
  readonly name: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The name a difference gets when it lies in no cell, so that no difference can go unreported. */
export const OUTSIDE_CELLS = "(outside cells)";

/** How one cell differs between the two captures. */
export interface CellDifference {
  /** The cell's name, or `OUTSIDE_CELLS`. */
  readonly cell: string;
  /** How many device pixels differ in at least one channel. */
  readonly pixels: number;
  /** The largest difference in one colour channel, 0-255. */
  readonly maxDiff: number;
  /** The smallest rectangle holding every differing pixel, in device pixels; both ends are included. */
  readonly box: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
}

/**
 * Compares two captures pixel by pixel, with no tolerance: a pixel differs
 * when any of its four channels differs by 1 or more.
 *
 * Returns one entry per cell that holds a differing pixel, in the order of
 * `cells`, then one entry named `OUTSIDE_CELLS` if a differing pixel lies in
 * no cell. Returns an empty list when the captures are identical. A pixel in
 * two overlapping cells counts for the first.
 *
 * Fails when the two captures differ in size, because then no pixel of one
 * has a partner in the other.
 */
export function compareBitmaps(
  reference: Bitmap,
  app: Bitmap,
  cells: ReadonlyArray<CellRect>,
): ReadonlyArray<CellDifference> {
  assertSameSize(reference, app);
  const found = new Map<string, MutableDifference>();
  const { width, height } = reference;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      let diff = 0;
      for (let channel = 0; channel < 4; channel++) {
        diff = Math.max(
          diff,
          Math.abs(reference.pixels[at + channel]! - app.pixels[at + channel]!),
        );
      }
      if (diff === 0) continue;
      const cell = findCell(cells, x, y);
      const entry = found.get(cell);
      if (entry === undefined) {
        found.set(cell, {
          cell,
          pixels: 1,
          maxDiff: diff,
          box: { left: x, top: y, right: x, bottom: y },
        });
        continue;
      }
      entry.pixels++;
      entry.maxDiff = Math.max(entry.maxDiff, diff);
      entry.box.left = Math.min(entry.box.left, x);
      entry.box.right = Math.max(entry.box.right, x);
      entry.box.bottom = y;
    }
  }
  const order = [...cells.map((cell) => cell.name), OUTSIDE_CELLS];
  return order.flatMap((name) => found.get(name) ?? []);
}

/**
 * Builds the picture of the differences: the reference in grey at a quarter
 * strength, so that each piece can still be recognised, with every differing
 * pixel in magenta. Returns a bitmap of the same size and byte order.
 *
 * Fails when the two captures differ in size.
 */
export function buildDiffBitmap(reference: Bitmap, app: Bitmap): Bitmap {
  assertSameSize(reference, app);
  const pixels = new Uint8Array(reference.pixels.length);
  for (let at = 0; at < pixels.length; at += 4) {
    const differs =
      reference.pixels[at] !== app.pixels[at] ||
      reference.pixels[at + 1] !== app.pixels[at + 1] ||
      reference.pixels[at + 2] !== app.pixels[at + 2] ||
      reference.pixels[at + 3] !== app.pixels[at + 3];
    if (differs) {
      pixels.set(MAGENTA, at);
      continue;
    }
    const [blue, green, red] = [
      reference.pixels[at]!,
      reference.pixels[at + 1]!,
      reference.pixels[at + 2]!,
    ];
    const grey = 0.299 * red + 0.587 * green + 0.114 * blue;
    // A quarter of the way from white to the pixel's grey.
    const faded = Math.round(255 - (255 - grey) / 4);
    pixels.set([faded, faded, faded, 255], at);
  }
  return { width: reference.width, height: reference.height, pixels };
}

/** Magenta, fully opaque, in BGRA order. */
const MAGENTA = [255, 0, 255, 255];

/** A `CellDifference` while it is being counted. */
interface MutableDifference {
  readonly cell: string;
  pixels: number;
  maxDiff: number;
  readonly box: { left: number; top: number; right: number; bottom: number };
}

/** Returns the name of the first cell that holds the device pixel at `x`, `y`, or `OUTSIDE_CELLS`. */
function findCell(cells: ReadonlyArray<CellRect>, x: number, y: number): string {
  const cell = cells.find(
    ({ left, top, width, height }) => x >= left && x < left + width && y >= top && y < top + height,
  );
  return cell?.name ?? OUTSIDE_CELLS;
}

/** Fails, naming both sizes, unless the two captures have the same width and height. */
function assertSameSize(reference: Bitmap, app: Bitmap): void {
  if (reference.width !== app.width || reference.height !== app.height) {
    throw new Error(
      `The captures differ in size: the reference is ${String(reference.width)}x${String(reference.height)} ` +
        `and the app's sheet is ${String(app.width)}x${String(app.height)}. Only captures of the same size can be compared.`,
    );
  }
}
