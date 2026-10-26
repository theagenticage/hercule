import { describe, expect, it } from "vitest";
import type { ProbeColour } from "../src/renderer/specimens/ui-probe-types.ts";
import {
  blendOver,
  computeApcaContrast,
  computeOklchLightness,
  computeWcagContrast,
  mixColours,
  packColour,
  unpackColour,
} from "./ui-colour.ts";

const BLACK: ProbeColour = [0, 0, 0, 1];
const WHITE: ProbeColour = [255, 255, 255, 1];
const GREY_888: ProbeColour = [136, 136, 136, 1];
const HALF_BLACK: ProbeColour = [0, 0, 0, 0.5];

// The expected values below were measured with colorjs.io 0.7.1 (contrastAPCA,
// contrastWCAG21 and the OKLCH conversion), an independent implementation, to
// pin the maths of ui-colour.ts. The library is not a dependency: it pulls the
// DOM type library into the Node typecheck.

describe("computeWcagContrast", () => {
  it("is 21 for black and white, in either order", () => {
    expect(computeWcagContrast(BLACK, WHITE)).toBeCloseTo(21, 5);
    expect(computeWcagContrast(WHITE, BLACK)).toBeCloseTo(21, 5);
  });

  it("is 1 for two equal colours", () => {
    expect(computeWcagContrast(WHITE, WHITE)).toBeCloseTo(1, 5);
  });

  it("fails for a colour that is not opaque", () => {
    expect(() => computeWcagContrast(HALF_BLACK, WHITE)).toThrow(/opaque/);
    expect(() => computeWcagContrast(WHITE, HALF_BLACK)).toThrow(/opaque/);
  });
});

describe("computeApcaContrast", () => {
  it("is positive for black text on white", () => {
    expect(computeApcaContrast(BLACK, WHITE)).toBeCloseTo(106.04, 1);
  });

  it("is negative for white text on black", () => {
    expect(computeApcaContrast(WHITE, BLACK)).toBeCloseTo(-107.88, 1);
  });

  it("is 0 for equal colours", () => {
    expect(computeApcaContrast(WHITE, WHITE)).toBeCloseTo(0, 5);
  });

  // The argument order matters: swapping text and background changes the value.
  it("gives the published value for #888 text on white", () => {
    expect(computeApcaContrast(GREY_888, WHITE)).toBeCloseTo(63.06, 1);
    expect(computeApcaContrast(WHITE, GREY_888)).toBeCloseTo(-68.54, 1);
  });

  it("fails for a text or background colour that is not opaque", () => {
    expect(() => computeApcaContrast(HALF_BLACK, WHITE)).toThrow(/text colour has alpha 0.5/);
    expect(() => computeApcaContrast(BLACK, HALF_BLACK)).toThrow(/background colour has alpha 0.5/);
  });
});

describe("computeOklchLightness", () => {
  it("is 1 for white and 0 for black", () => {
    expect(computeOklchLightness(WHITE)).toBeCloseTo(1, 5);
    expect(computeOklchLightness(BLACK)).toBeCloseTo(0, 5);
  });

  it("is about 0.195 (0.1945) for the dark theme background #1a1310", () => {
    expect(computeOklchLightness([0x1a, 0x13, 0x10, 1])).toBeCloseTo(0.19447, 4);
  });

  it("fails for a colour that is not opaque", () => {
    expect(() => computeOklchLightness(HALF_BLACK)).toThrow(/opaque/);
  });
});

describe("blendOver", () => {
  it("puts 50% black over white halfway, without rounding", () => {
    expect(blendOver(HALF_BLACK, WHITE)).toEqual([127.5, 127.5, 127.5, 1]);
  });

  it("returns the top colour when it is opaque and the bottom when the top is clear", () => {
    expect(blendOver(BLACK, WHITE)).toEqual(BLACK);
    expect(blendOver([0, 0, 0, 0], WHITE)).toEqual(WHITE);
  });

  it("follows Porter-Duff for the alpha of two see-through colours", () => {
    // Red at 50% over blue at 50%: alpha 0.5 + 0.5 * 0.5 = 0.75, and red
    // weighs 0.5 / 0.75 = 2/3 of the channels.
    const [red, green, blue, alpha] = blendOver([255, 0, 0, 0.5], [0, 0, 255, 0.5]);
    expect(alpha).toBeCloseTo(0.75, 10);
    expect(red).toBeCloseTo(170, 10);
    expect(green).toBeCloseTo(0, 10);
    expect(blue).toBeCloseTo(85, 10);
  });

  it("returns transparent black when both colours are clear", () => {
    expect(blendOver([10, 20, 30, 0], [40, 50, 60, 0])).toEqual([0, 0, 0, 0]);
  });
});

describe("mixColours", () => {
  it("returns the first colour at weight 1 and the second at weight 0", () => {
    expect(mixColours(BLACK, WHITE, 1)).toEqual(BLACK);
    expect(mixColours(BLACK, WHITE, 0)).toEqual(WHITE);
  });

  it("weighs every channel, alpha included", () => {
    expect(mixColours([200, 100, 0, 1], [0, 100, 200, 0], 0.25)).toEqual([50, 100, 150, 0.25]);
  });

  it("matches what an opacity of 0.4 does to flat text over a flat background", () => {
    const text: ProbeColour = [240, 230, 220, 1];
    const background: ProbeColour = [26, 19, 16, 1];
    const mixed = mixColours(text, background, 0.4);
    const blended = blendOver([text[0], text[1], text[2], 0.4], background);
    for (const index of [0, 1, 2, 3] as const) {
      expect(mixed[index]).toBeCloseTo(blended[index], 10);
    }
  });
});

describe("packColour and unpackColour", () => {
  it("packs to 0xRRGGBBAA, as readUInt32BE reads a PNG pixel", () => {
    expect(packColour([0x12, 0x34, 0x56, 1])).toBe(0x123456ff);
    expect(packColour([255, 255, 255, 1])).toBe(0xffffffff);
    expect(packColour([0, 0, 0, 0])).toBe(0);
    const pixel = Buffer.from([0x12, 0x34, 0x56, 0x80]);
    expect(unpackColour(pixel.readUInt32BE(0))).toEqual([0x12, 0x34, 0x56, 0x80 / 255]);
  });

  it("rounds channels and rounds alpha times 255", () => {
    expect(packColour([0.4, 127.5, 254.6, 0.5])).toBe(
      0x00 * 2 ** 24 + 0x80 * 2 ** 16 + 0xff * 2 ** 8 + 0x80,
    );
  });

  it("round-trips every alpha and a spread of channels", () => {
    for (let alpha = 0; alpha <= 255; alpha++) {
      const colour: ProbeColour = [alpha, 255 - alpha, (alpha * 7) % 256, alpha / 255];
      expect(unpackColour(packColour(colour))).toEqual(colour);
    }
  });
});
