import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildTokensKotlin,
  convertOklabToDisplayP3,
  convertOklchToOklab,
  parseColor,
  TOKENS_CSS_PATH,
  TOKENS_KOTLIN_PATH,
} from "./gen-android-tokens";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Converts a CSS colour to Display P3 and returns its channels and alpha, rounded to six places. */
const convertToP3 = (css: string): Array<number> => {
  const p3 = convertOklabToDisplayP3(parseColor(css));
  return [p3.red, p3.green, p3.blue, p3.alpha].map((v) => Number(v.toFixed(6)));
};

describe("gen-android-tokens", () => {
  it("matches the checked-in Tokens.kt; run `pnpm gen:android-tokens` when this fails", async () => {
    const css = await readFile(`${root}${TOKENS_CSS_PATH}`, "utf8");
    const checkedIn = await readFile(`${root}${TOKENS_KOTLIN_PATH}`, "utf8");
    expect(checkedIn).toBe(buildTokensKotlin(css));
  });

  // The expected values come from colorjs.io 0.5.2, an independent
  // implementation of CSS Color 4: `new Color(css).to("p3").coords`, and
  // `Color.mix(a, b, p, { space: "oklab", premultiplied: true })` for mixes.
  it.each([
    ["oklch(0.7 0.15 30)", [0.868954, 0.488521, 0.416767, 1]],
    ["oklch(0.965 0.005 95)", [0.95746, 0.954578, 0.94135, 1]],
    ["oklch(0.62 0.19 27)", [0.818403, 0.332447, 0.287673, 1]],
    ["white", [1, 1, 1, 1]],
    ["oklch(0 0 0 / 0.25)", [0, 0, 0, 0.25]],
    [
      "color-mix(in oklab, oklch(0.45 0.09 164) 80%, oklch(0.22 0.014 165))",
      [0.16401, 0.329311, 0.248459, 1],
    ],
    [
      "color-mix(in oklab, oklch(0.99 0.003 95) calc(100% - 24% * 0.4), transparent)",
      [0.988889, 0.987154, 0.979169, 0.904],
    ],
  ])("converts %s to Display P3 as colorjs.io does", (css, expected) => {
    expect(convertToP3(css)).toEqual(expected);
  });

  it("converts sRGB red, written in oklch, to its Display P3 value", () => {
    // sRGB red is oklch(0.627955 0.257683 29.2339); colorjs.io 0.5.2 gives
    // `new Color("red").to("p3")` as 0.917488 0.200287 0.138561.
    const p3 = convertOklabToDisplayP3(convertOklchToOklab(0.627955, 0.257683, 29.2339));
    expect([p3.red, p3.green, p3.blue].map((v) => Number(v.toFixed(4)))).toEqual([
      0.9175, 0.2003, 0.1386,
    ]);
  });

  it("mixes with transparent by lowering the alpha only, as premultiplied color-mix() does", () => {
    const ink = convertToP3("oklch(0.22 0.014 165)");
    expect(convertToP3("color-mix(in oklab, oklch(0.22 0.014 165) 5%, transparent)")).toEqual([
      ...ink.slice(0, 3),
      0.05,
    ]);
  });

  it("clamps a colour outside Display P3 and flags it, but not one inside", () => {
    // Whitehaven's teal --who-ink: colorjs.io gives a red channel of -0.144211.
    const outside = convertOklabToDisplayP3(convertOklchToOklab(0.49, 0.13125, 198));
    expect(outside.clamped).toBe(true);
    expect(outside.red).toBe(0);
    expect(convertOklabToDisplayP3(convertOklchToOklab(0.78, 0.125, 198)).clamped).toBe(false);
    expect(convertOklabToDisplayP3(parseColor("white")).clamped).toBe(false);
  });

  it("refuses a colour syntax it does not read rather than guessing", () => {
    expect(() => parseColor("rgb(255 0 0)")).toThrow(/not a colour this script reads/);
  });
});
