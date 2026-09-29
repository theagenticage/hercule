import { describe, expect, it } from "vitest";
import {
  buildDiffBitmap,
  compareBitmaps,
  OUTSIDE_CELLS,
  type Bitmap,
  type CellRect,
} from "./compare-bitmaps.ts";

// The synthetic sheets are drawn at DPR 2, as the real ones are: one CSS pixel
// is 2 × 2 device pixels, and every coordinate below is in device pixels.
const DPR = 2;
const WIDTH = 40 * DPR;
const HEIGHT = 20 * DPR;

// Two cells side by side, each 16 CSS pixels square, 2 CSS pixels from the
// top-left corner and from each other. Everything else is outside every cell.
const CELLS: ReadonlyArray<CellRect> = [
  { name: "face/idle/22", left: 2 * DPR, top: 2 * DPR, width: 16 * DPR, height: 16 * DPR },
  { name: "mark/working", left: 20 * DPR, top: 2 * DPR, width: 16 * DPR, height: 16 * DPR },
];

/** Builds a white, opaque bitmap of the test sheet's size. */
function buildWhiteBitmap(): Bitmap {
  return { width: WIDTH, height: HEIGHT, pixels: new Uint8Array(WIDTH * HEIGHT * 4).fill(255) };
}

/** Paints a black square `size` device pixels wide with its top-left corner at `x`, `y`. */
function paintSquare(bitmap: Bitmap, x: number, y: number, size: number): void {
  for (let row = y; row < y + size; row++) {
    for (let column = x; column < x + size; column++) {
      bitmap.pixels.set([0, 0, 0, 255], (row * bitmap.width + column) * 4);
    }
  }
}

describe("compareBitmaps", () => {
  it("finds no difference between identical bitmaps", () => {
    expect(compareBitmaps(buildWhiteBitmap(), buildWhiteBitmap(), CELLS)).toEqual([]);
  });

  it("reports one channel of one pixel off by 1 in its cell, with that pixel's box", () => {
    const app = buildWhiteBitmap();
    const [x, y] = [25 * DPR, 7 * DPR + 1];
    app.pixels[(y * WIDTH + x) * 4 + 1] = 254;

    expect(compareBitmaps(buildWhiteBitmap(), app, CELLS)).toEqual([
      {
        cell: "mark/working",
        pixels: 1,
        maxDiff: 1,
        box: { left: x, top: y, right: x, bottom: y },
      },
    ]);
  });

  it("reports a square moved by one CSS pixel in its cell, with a box covering both positions", () => {
    const reference = buildWhiteBitmap();
    const app = buildWhiteBitmap();
    // A 4 × 4 square: 8 × 8 device pixels. The app draws it one CSS pixel,
    // two device pixels, further right.
    paintSquare(reference, 6 * DPR, 6 * DPR, 4 * DPR);
    paintSquare(app, 7 * DPR, 6 * DPR, 4 * DPR);

    expect(compareBitmaps(reference, app, CELLS)).toEqual([
      {
        cell: "face/idle/22",
        // The two device-pixel columns the square left, and the two it entered.
        pixels: 2 * 2 * 4 * DPR,
        maxDiff: 255,
        box: { left: 6 * DPR, top: 6 * DPR, right: 11 * DPR - 1, bottom: 10 * DPR - 1 },
      },
    ]);
  });

  it("reports a difference outside every cell as outside cells, after the cells", () => {
    const app = buildWhiteBitmap();
    paintSquare(app, 0, 0, 1);
    paintSquare(app, 3 * DPR, 3 * DPR, 1);

    expect(compareBitmaps(buildWhiteBitmap(), app, CELLS).map(({ cell }) => cell)).toEqual([
      "face/idle/22",
      OUTSIDE_CELLS,
    ]);
  });

  it("fails on bitmaps of different sizes", () => {
    const smaller: Bitmap = {
      width: WIDTH - DPR,
      height: HEIGHT,
      pixels: new Uint8Array((WIDTH - DPR) * HEIGHT * 4),
    };

    expect(() => compareBitmaps(buildWhiteBitmap(), smaller, CELLS)).toThrow(
      "The captures differ in size: the reference is 80x40 and the app's sheet is 78x40.",
    );
  });
});

describe("buildDiffBitmap", () => {
  it("draws differing pixels in magenta and the rest as a faded grey of the reference", () => {
    const reference = buildWhiteBitmap();
    paintSquare(reference, 0, 0, 2);
    const app = buildWhiteBitmap();
    paintSquare(app, 0, 0, 2);
    app.pixels.set([0, 0, 255, 255], (1 * WIDTH + 4) * 4);

    const diff = buildDiffBitmap(reference, app);

    // Black fades to a quarter of the way from white: 255 - 255 / 4.
    expect([...diff.pixels.subarray(0, 4)]).toEqual([191, 191, 191, 255]);
    expect([...diff.pixels.subarray((1 * WIDTH + 4) * 4, (1 * WIDTH + 4) * 4 + 4)]).toEqual([
      255, 0, 255, 255,
    ]);
    expect([...diff.pixels.subarray(8 * 4, 8 * 4 + 4)]).toEqual([255, 255, 255, 255]);
  });
});
