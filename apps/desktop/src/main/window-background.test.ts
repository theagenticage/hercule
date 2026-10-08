import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_APPEARANCE, THEMES } from "../ipc/appearance";
import { chooseWindowBackground, WINDOW_BACKGROUND } from "./window-background";

const readStyles = (name: string): string =>
  readFileSync(new URL(`../renderer/styles/${name}`, import.meta.url), "utf8");
const tokens = readStyles("tokens.css");
const base = readStyles("base.css");

/**
 * Returns the body of the first rule in `css` whose selector list includes
 * `selector`, or undefined when there is none.
 */
const findRule = (css: string, selector: string): string | undefined =>
  css.split("}").find((block) => block.slice(0, block.indexOf("{")).includes(selector));

/**
 * Returns the `--bg` that tokens.css gives the theme `selector`, as its oklch
 * lightness, chroma and hue. Fails the test when there is none.
 */
const readBackgroundToken = (selector: string): [number, number, number] => {
  const match = findRule(tokens, selector)?.match(/--bg:\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/);
  if (match === null || match === undefined) throw new Error(`No oklch --bg for ${selector}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

/**
 * Returns the hex `--bg` that base.css gives the theme `selector`, or
 * undefined when base.css gives it none.
 */
const readBackgroundOverride = (selector: string): string | undefined =>
  findRule(base, selector)?.match(/--bg:\s*(#[0-9a-f]{6});/)?.[1];

/**
 * Converts an in-gamut oklch colour to sRGB hex, by the formulas of CSS Color
 * 4 (oklch to OKLab to linear sRGB, then the sRGB transfer function), rounded
 * to 8 bits per channel as Chromium paints it.
 */
const convertOklchToHex = ([lightness, chroma, hue]: [number, number, number]): string => {
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${linear
    .map((channel) =>
      channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055,
    )
    .map((channel) =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
};

describe("the window background", () => {
  it.each(THEMES)("is the --bg of %s in tokens.css, as 8-bit sRGB", (theme) => {
    expect(WINDOW_BACKGROUND[theme]).toBe(
      convertOklchToHex(readBackgroundToken(`[data-theme="${theme}"]`)),
    );
  });

  it.each(THEMES)("is the exact --bg that base.css gives the page in %s", (theme) => {
    expect(readBackgroundOverride(`[data-theme="${theme}"]`)).toBe(WINDOW_BACKGROUND[theme]);
  });

  it("is the theme in use's: by macOS's appearance with Follow the system on, the chosen theme with it off", () => {
    const followSystem = { ...DEFAULT_APPEARANCE, dayTheme: "styles", nightTheme: "nile" } as const;
    expect(chooseWindowBackground(followSystem, false)).toBe(WINDOW_BACKGROUND.styles);
    expect(chooseWindowBackground(followSystem, true)).toBe(WINDOW_BACKGROUND.nile);
    const endHouse = { ...followSystem, followSystem: false, theme: "end-house" } as const;
    expect(chooseWindowBackground(endHouse, false)).toBe(WINDOW_BACKGROUND["end-house"]);
  });
});
