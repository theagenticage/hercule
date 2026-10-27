import { describe, expect, it } from "vitest";
import type {
  ProbeColour,
  ProbeRect,
  TextFragment,
} from "../src/renderer/specimens/ui-probe-types.ts";
import { computeApcaContrast, computeWcagContrast, packColour } from "./ui-colour.ts";
import {
  checkFocusRing,
  checkNonTextPart,
  computePercentile,
  countColours,
  countDifferingPixels,
  findModeColour,
  measureBoundaryContrast,
  measureFragmentContrast,
  type DecodedImage,
} from "./ui-pixels.ts";

const WHITE: ProbeColour = [255, 255, 255, 1];
const BLACK: ProbeColour = [0, 0, 0, 1];

interface MutableImage extends DecodedImage {
  readonly data: Uint8Array;
}

/** Builds an image of one colour, `width` by `height` device pixels. */
function buildImage(width: number, height: number, colour: ProbeColour): MutableImage {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data.set([colour[0], colour[1], colour[2], Math.round(colour[3] * 255)], index * 4);
  }
  return { width, height, data };
}

/** Paints the device pixels from `left`, `top` up to but not including `right`, `bottom`. */
function paint(
  image: MutableImage,
  [left, top, right, bottom]: readonly [number, number, number, number],
  colour: ProbeColour,
): void {
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      image.data.set([colour[0], colour[1], colour[2], 255], (y * image.width + x) * 4);
    }
  }
}

/** Returns a copy of the image. */
function copyImage(image: DecodedImage): MutableImage {
  return { width: image.width, height: image.height, data: image.data.slice() };
}

/** Returns the part of the image that `clip` (CSS px) covers, as its own image. */
function cropImage(image: DecodedImage, clip: ProbeRect, scale: number): MutableImage {
  const left = clip.left * scale;
  const top = clip.top * scale;
  const width = (clip.right - clip.left) * scale;
  const height = (clip.bottom - clip.top) * scale;
  const cropped = buildImage(width, height, BLACK);
  for (let y = 0; y < height; y += 1) {
    const from = ((top + y) * image.width + left) * 4;
    cropped.data.set(image.data.subarray(from, from + width * 4), y * width * 4);
  }
  return cropped;
}

function buildFragment(overrides: Partial<TextFragment>): TextFragment {
  return {
    sourceId: 1,
    length: 5,
    box: { left: 0, top: 0, right: 20, bottom: 10 },
    visibleBox: { left: 0, top: 0, right: 20, bottom: 10 },
    fontSize: 13,
    fontWeight: 400,
    colour: BLACK,
    role: "ink",
    opacityGroups: [],
    isProse: false,
    partlyCovered: false,
    ...overrides,
  };
}

describe("countColours", () => {
  it("counts the pixels of the box by colour", () => {
    const image = buildImage(10, 10, WHITE);
    paint(image, [0, 0, 2, 10], BLACK);
    const counts = countColours(image, { left: 0, top: 0, right: 4, bottom: 10 }, 1);
    expect(counts.get(packColour(BLACK))).toBe(20);
    expect(counts.get(packColour(WHITE))).toBe(20);
    expect(counts.size).toBe(2);
  });

  it("multiplies the box by the scale", () => {
    const image = buildImage(20, 20, WHITE);
    const counts = countColours(image, { left: 1, top: 1, right: 3, bottom: 4 }, 2);
    expect(counts.get(packColour(WHITE))).toBe(4 * 6);
  });

  it("keeps only the part of the box on the image", () => {
    const image = buildImage(10, 10, WHITE);
    const counts = countColours(image, { left: -5, top: 8, right: 5, bottom: 20 }, 1);
    expect(counts.get(packColour(WHITE))).toBe(5 * 2);
  });

  it("gives an empty map for a box wholly outside the image", () => {
    const image = buildImage(10, 10, WHITE);
    expect(countColours(image, { left: 10, top: 0, right: 20, bottom: 5 }, 1).size).toBe(0);
    expect(countColours(image, { left: -9, top: -9, right: -1, bottom: -1 }, 1).size).toBe(0);
  });
});

describe("findModeColour", () => {
  it("returns the colour with the most pixels", () => {
    const counts = new Map([
      [packColour(BLACK), 3],
      [packColour(WHITE), 7],
    ]);
    expect(findModeColour(counts)).toEqual(WHITE);
  });

  it("returns null for no pixels", () => {
    expect(findModeColour(new Map())).toBeNull();
  });

  it("breaks a tie by the lower packed colour", () => {
    const counts = new Map([
      [packColour(WHITE), 5],
      [packColour(BLACK), 5],
    ]);
    expect(findModeColour(counts)).toEqual(BLACK);
  });
});

describe("computePercentile", () => {
  const values = [
    { value: 30, weight: 5 },
    { value: 10, weight: 1 },
    { value: 20, weight: 4 },
  ];

  it("returns the lowest value that holds the fraction of the weight", () => {
    expect(computePercentile(values, 0.1)).toBe(10);
    expect(computePercentile(values, 0.11)).toBe(20);
    expect(computePercentile(values, 0.5)).toBe(20);
    expect(computePercentile(values, 0.51)).toBe(30);
  });

  it("fails without entries", () => {
    expect(() => computePercentile([], 0.1)).toThrow(/at least one entry/);
  });
});

describe("measureFragmentContrast", () => {
  const darkText: ProbeColour = [60, 60, 60, 1];
  const light: ProbeColour = [240, 240, 240, 1];
  const dark: ProbeColour = [20, 20, 20, 1];

  it("measures text over one solid surface", () => {
    const image = buildImage(20, 10, WHITE);
    const result = measureFragmentContrast(buildFragment({ colour: BLACK }), image, null, 1);
    expect(result).toEqual({
      apcaLc: computeApcaContrast(BLACK, WHITE),
      wcagRatio: 21,
      supported: true,
    });
    expect(result?.apcaLc).toBeGreaterThan(100);
  });

  it("keeps the sign of light text on a dark surface", () => {
    const image = buildImage(20, 10, BLACK);
    const result = measureFragmentContrast(buildFragment({ colour: WHITE }), image, null, 1);
    expect(result?.apcaLc).toBeLessThan(-100);
    expect(result?.wcagRatio).toBeCloseTo(21, 5);
  });

  it("blends text with alpha over the surface", () => {
    const image = buildImage(20, 10, WHITE);
    const result = measureFragmentContrast(
      buildFragment({ colour: [0, 0, 0, 0.5] }),
      image,
      null,
      1,
    );
    const blended: ProbeColour = [127.5, 127.5, 127.5, 1];
    expect(result?.wcagRatio).toBeCloseTo(computeWcagContrast(blended, WHITE), 6);
    expect(result?.apcaLc).toBeCloseTo(computeApcaContrast(blended, WHITE), 6);
  });

  it("takes the worse surface when it covers more than 10% of the box", () => {
    const image = buildImage(20, 10, light);
    paint(image, [17, 0, 20, 10], dark);
    const result = measureFragmentContrast(buildFragment({ colour: darkText }), image, null, 1);
    expect(result?.wcagRatio).toBeCloseTo(computeWcagContrast(darkText, dark), 6);
    expect(result?.apcaLc).toBeCloseTo(computeApcaContrast(darkText, dark), 6);
  });

  it("ignores the worse surface when it covers 10% or less", () => {
    const image = buildImage(20, 10, light);
    paint(image, [19, 0, 20, 10], dark);
    const result = measureFragmentContrast(buildFragment({ colour: darkText }), image, null, 1);
    expect(result?.wcagRatio).toBeCloseTo(computeWcagContrast(darkText, light), 6);
  });

  it("gives a result over a gradient where no colour dominates", () => {
    const image = buildImage(20, 10, WHITE);
    for (let x = 0; x < 20; x += 1) {
      const level = 200 + x * 2;
      paint(image, [x, 0, x + 1, 10], [level, level, level, 1]);
    }
    const result = measureFragmentContrast(buildFragment({ colour: darkText }), image, null, 1);
    // The 10% mark falls on the second-darkest column of 20.
    expect(result?.wcagRatio).toBeCloseTo(computeWcagContrast(darkText, [202, 202, 202, 1]), 6);
  });

  it("reads the box at the given scale", () => {
    const image = buildImage(40, 20, WHITE);
    paint(image, [20, 0, 40, 20], BLACK);
    const fragment = buildFragment({
      colour: WHITE,
      visibleBox: { left: 10, top: 0, right: 20, bottom: 10 },
    });
    expect(measureFragmentContrast(fragment, image, null, 2)?.wcagRatio).toBeCloseTo(21, 5);
  });

  it("returns null when nothing of the fragment is visible", () => {
    const image = buildImage(20, 10, WHITE);
    expect(measureFragmentContrast(buildFragment({ visibleBox: null }), image, null, 1)).toBeNull();
    const outside = buildFragment({ visibleBox: { left: 30, top: 0, right: 40, bottom: 10 } });
    expect(measureFragmentContrast(outside, image, null, 1)).toBeNull();
  });

  describe("with an opacity group", () => {
    // The group has its own surface G (200) over the backdrop B (100), at opacity 0.5, so the surface seen is 150.
    const backdrop: ProbeColour = [100, 100, 100, 1];
    const surface: ProbeColour = [150, 150, 150, 1];
    const textHidden = buildImage(20, 10, surface);
    const behind = buildImage(20, 10, backdrop);
    const oneGroup = [{ id: 1, opacity: 0.5 }];

    it("equals the exact compositing for opaque text", () => {
      const result = measureFragmentContrast(
        buildFragment({ colour: WHITE, opacityGroups: oneGroup }),
        textHidden,
        behind,
        1,
      );
      // White text in the group shows as 0.5 * white + 0.5 * backdrop.
      const shown: ProbeColour = [177.5, 177.5, 177.5, 1];
      expect(result?.supported).toBe(true);
      expect(result?.wcagRatio).toBeCloseTo(computeWcagContrast(shown, surface), 6);
      expect(result?.apcaLc).toBeCloseTo(computeApcaContrast(shown, surface), 6);
    });

    it("recovers the group's own surface for text with alpha", () => {
      const result = measureFragmentContrast(
        buildFragment({ colour: [0, 0, 0, 0.5], opacityGroups: oneGroup }),
        textHidden,
        behind,
        1,
      );
      // Half black over G (200) is 100; mixed half and half with B (100) it stays 100.
      // Using the surface (150) in place of G would give 87.5, which is wrong.
      const shown: ProbeColour = [100, 100, 100, 1];
      expect(result?.wcagRatio).toBeCloseTo(computeWcagContrast(shown, surface), 6);
      expect(result?.apcaLc).toBeCloseTo(computeApcaContrast(shown, surface), 6);
    });

    it("needs the capture with the group hidden", () => {
      expect(() =>
        measureFragmentContrast(
          buildFragment({ colour: WHITE, opacityGroups: oneGroup }),
          textHidden,
          null,
          1,
        ),
      ).toThrow(/group hidden/);
    });

    it("is not supported for nested groups, and uses the product of the opacities", () => {
      const nested = [
        { id: 1, opacity: 0.5 },
        { id: 2, opacity: 0.5 },
      ];
      const result = measureFragmentContrast(
        buildFragment({ colour: WHITE, opacityGroups: nested }),
        textHidden,
        behind,
        1,
      );
      // White at opacity 0.25 over backdrop 100, against the surface 150.
      const shown: ProbeColour = [
        0.25 * 255 + 0.75 * 100,
        0.25 * 255 + 0.75 * 100,
        0.25 * 255 + 0.75 * 100,
        1,
      ];
      expect(result?.supported).toBe(false);
      expect(result?.wcagRatio).toBeCloseTo(computeWcagContrast(shown, surface), 6);
    });
  });
});

describe("checkFocusRing", () => {
  const target: ProbeRect = { left: 20, top: 15, right: 40, bottom: 25 };
  const clip: ProbeRect = { left: 8, top: 3, right: 52, bottom: 37 };

  /** Paints a ring `thickness` px wide around the target, in a copy of the golden, and crops the clip. */
  function focusWithRing(golden: DecodedImage, colour: ProbeColour, scale: number) {
    const focused = copyImage(golden);
    const thickness = 2 * scale;
    const [left, top, right, bottom] = [
      target.left * scale,
      target.top * scale,
      target.right * scale,
      target.bottom * scale,
    ];
    paint(focused, [left - thickness, top - thickness, right + thickness, top], colour);
    paint(focused, [left - thickness, bottom, right + thickness, bottom + thickness], colour);
    paint(focused, [left - thickness, top, left, bottom], colour);
    paint(focused, [right, top, right + thickness, bottom], colour);
    return cropImage(focused, clip, scale);
  }

  it("sees a ring of contrasting colour around the target", () => {
    const golden = buildImage(60, 40, WHITE);
    const result = checkFocusRing(
      golden,
      focusWithRing(golden, [0, 0, 255, 1], 1),
      clip,
      target,
      1,
    );
    expect(result.visible).toBe(true);
    expect(result.requiredPixels).toBe(30);
    expect(result.qualifyingPixels).toBe(24 * 14 - 20 * 10);
  });

  it("measures at the device scale", () => {
    const golden = buildImage(120, 80, WHITE);
    const result = checkFocusRing(
      golden,
      focusWithRing(golden, [0, 0, 255, 1], 2),
      clip,
      target,
      2,
    );
    expect(result.visible).toBe(true);
    expect(result.requiredPixels).toBe(60);
  });

  it("does not see a change of one pixel", () => {
    const golden = buildImage(60, 40, WHITE);
    const focused = copyImage(golden);
    paint(focused, [30, 20, 31, 21], BLACK);
    const result = checkFocusRing(golden, cropImage(focused, clip, 1), clip, target, 1);
    expect(result).toEqual({ visible: false, qualifyingPixels: 1, requiredPixels: 30 });
  });

  it("does not see a ring of low contrast", () => {
    const golden = buildImage(60, 40, WHITE);
    const result = checkFocusRing(
      golden,
      focusWithRing(golden, [215, 215, 255, 1], 1),
      clip,
      target,
      1,
    );
    expect(result.visible).toBe(false);
    expect(result.qualifyingPixels).toBe(0);
  });

  it("compares with the unfocused capture's pixels at the clip's position", () => {
    // The capture is black where the clip is, so a white clip differs everywhere.
    const unfocused = buildImage(60, 40, BLACK);
    const result = checkFocusRing(unfocused, buildImage(44, 34, WHITE), clip, target, 1);
    expect(result.qualifyingPixels).toBe(44 * 34);
  });
});

describe("countDifferingPixels", () => {
  const first: ProbeRect = { left: 2, top: 2, right: 6, bottom: 6 };
  const second: ProbeRect = { left: 10, top: 2, right: 14, bottom: 6 };

  it("counts the pixels where any channel differs by more than 32", () => {
    const image = buildImage(20, 10, WHITE);
    paint(image, [2, 2, 3, 3], BLACK);
    paint(image, [3, 2, 4, 3], [223, 255, 255, 1]);
    paint(image, [4, 2, 5, 3], [222, 255, 255, 1]);
    // Black against white differs, 32 off in one channel does not, 33 off does.
    expect(countDifferingPixels(image, first, second, 1)).toBe(2);
  });

  it("is 0 for two identical cells", () => {
    const image = buildImage(20, 10, WHITE);
    paint(image, [2, 2, 4, 6], BLACK);
    paint(image, [10, 2, 12, 6], BLACK);
    expect(countDifferingPixels(image, first, second, 1)).toBe(0);
  });

  it("measures at the device scale", () => {
    const image = buildImage(40, 20, WHITE);
    paint(image, [4, 4, 6, 6], BLACK);
    expect(countDifferingPixels(image, first, second, 2)).toBe(4);
  });

  it("fails when the cells differ in size or reach outside the image", () => {
    const image = buildImage(20, 10, WHITE);
    expect(() =>
      countDifferingPixels(image, first, { ...second, right: second.right + 1 }, 1),
    ).toThrow(/different sizes/);
    expect(() =>
      countDifferingPixels(image, first, { left: 18, top: 2, right: 22, bottom: 6 }, 1),
    ).toThrow(/outside the image/);
  });
});

describe("measureBoundaryContrast", () => {
  const box: ProbeRect = { left: 10, top: 10, right: 50, bottom: 30 };
  const grey: ProbeColour = [118, 118, 118, 1];

  it("returns the ratio of a border drawn on all sides, which is the check's own ratio", () => {
    const image = buildImage(60, 40, WHITE);
    paint(image, [10, 10, 50, 30], grey);
    paint(image, [12, 12, 48, 28], WHITE);
    const ratio = measureBoundaryContrast(image, box, 1);
    expect(ratio).toBeCloseTo(computeWcagContrast(grey, WHITE), 6);
    expect(checkNonTextPart(image, box, "boundary", 1).passes).toBe(ratio >= 3);
  });

  it("returns 1 for a box with no border", () => {
    expect(measureBoundaryContrast(buildImage(60, 40, WHITE), box, 1)).toBe(1);
  });

  it("returns 1 for a border drawn on one short side only", () => {
    const image = buildImage(60, 40, WHITE);
    paint(image, [10, 10, 12, 30], grey);
    expect(measureBoundaryContrast(image, box, 1)).toBe(1);
  });

  it("reads the weaker colour when the strong one covers less than half of the perimeter", () => {
    const image = buildImage(60, 40, WHITE);
    const pale: ProbeColour = [200, 200, 200, 1];
    paint(image, [10, 10, 50, 30], pale);
    paint(image, [12, 12, 48, 28], WHITE);
    paint(image, [10, 10, 14, 30], grey);
    expect(measureBoundaryContrast(image, box, 1)).toBeCloseTo(computeWcagContrast(pale, WHITE), 6);
  });

  it("reads the band at the device scale", () => {
    const image = buildImage(120, 80, WHITE);
    paint(image, [20, 20, 100, 60], grey);
    paint(image, [24, 24, 96, 56], WHITE);
    expect(measureBoundaryContrast(image, box, 2)).toBeCloseTo(computeWcagContrast(grey, WHITE), 6);
  });
});

describe("checkNonTextPart", () => {
  const box: ProbeRect = { left: 10, top: 10, right: 50, bottom: 30 };
  const grey: ProbeColour = [118, 118, 118, 1];

  it("passes a boundary that is drawn on all sides", () => {
    const image = buildImage(60, 40, WHITE);
    paint(image, [10, 10, 50, 30], grey);
    paint(image, [12, 12, 48, 28], WHITE);
    const result = checkNonTextPart(image, box, "boundary", 1);
    expect(result.passes).toBe(true);
    expect(result.outsideColour).toEqual(WHITE);
    expect(result.requiredPixels).toBe(60);
    expect(result.qualifyingPixels).toBe(40 * 20 - 36 * 16);
  });

  it("fails a boundary with no border", () => {
    const image = buildImage(60, 40, WHITE);
    const result = checkNonTextPart(image, box, "boundary", 1);
    expect(result).toEqual({
      passes: false,
      qualifyingPixels: 0,
      requiredPixels: 60,
      outsideColour: WHITE,
    });
  });

  it("fails a boundary drawn on one short side only", () => {
    const image = buildImage(60, 40, WHITE);
    paint(image, [10, 10, 12, 30], grey);
    const result = checkNonTextPart(image, box, "boundary", 1);
    expect(result.qualifyingPixels).toBe(40);
    expect(result.passes).toBe(false);
  });

  it("fails a boundary whose colour is too close to the outside", () => {
    const image = buildImage(60, 40, WHITE);
    paint(image, [10, 10, 50, 30], [225, 225, 225, 1]);
    paint(image, [12, 12, 48, 28], WHITE);
    expect(checkNonTextPart(image, box, "boundary", 1).passes).toBe(false);
  });

  it("reads the boundary band at the device scale", () => {
    const image = buildImage(120, 80, WHITE);
    paint(image, [20, 20, 100, 60], grey);
    paint(image, [24, 24, 96, 56], WHITE);
    const result = checkNonTextPart(image, box, "boundary", 2);
    expect(result.passes).toBe(true);
    expect(result.requiredPixels).toBe(120);
    expect(result.qualifyingPixels).toBe(80 * 40 - 72 * 32);
  });

  describe("marks", () => {
    const markBox: ProbeRect = { left: 20, top: 10, right: 30, bottom: 20 };

    it("passes a cross that spans the box", () => {
      const image = buildImage(60, 40, WHITE);
      paint(image, [20, 14, 30, 16], BLACK);
      paint(image, [24, 10, 26, 20], BLACK);
      const result = checkNonTextPart(image, markBox, "mark", 1);
      expect(result.passes).toBe(true);
      expect(result.requiredPixels).toBe(20);
      expect(result.qualifyingPixels).toBe(10 * 2 + 10 * 2 - 4);
    });

    it("fails a single pixel of high contrast", () => {
      const image = buildImage(60, 40, WHITE);
      paint(image, [25, 15, 26, 16], BLACK);
      const result = checkNonTextPart(image, markBox, "mark", 1);
      expect(result.qualifyingPixels).toBe(1);
      expect(result.passes).toBe(false);
    });
  });

  it("fails when the box has no pixels around it on the image", () => {
    const image = buildImage(60, 40, WHITE);
    const result = checkNonTextPart(
      image,
      { left: 100, top: 100, right: 120, bottom: 110 },
      "mark",
      1,
    );
    expect(result).toEqual({
      passes: false,
      qualifyingPixels: 0,
      requiredPixels: 30,
      outsideColour: null,
    });
  });

  it("reads only the part of the band that is on the image", () => {
    const image = buildImage(60, 40, WHITE);
    paint(image, [0, 0, 60, 2], grey);
    const result = checkNonTextPart(
      image,
      { left: 0, top: 0, right: 60, bottom: 20 },
      "boundary",
      1,
    );
    expect(result.outsideColour).toEqual(WHITE);
    expect(result.qualifyingPixels).toBe(120);
    expect(result.passes).toBe(true);
  });
});
