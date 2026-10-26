import type { ProbeColour } from "../src/renderer/specimens/ui-probe-types.ts";

/**
 * Colour maths for the UI metrics (docs/research/ui-hill-climb.md, section
 * 4.1): compositing, contrast and lightness of the `ProbeColour` values the
 * UI probe reads from a page. It is written here, not taken from a library,
 * because the libraries that offer it pull the DOM type library into the Node
 * typecheck of the desktop scripts.
 */

/** Returns a channel from 0 to 255 as the linear light of sRGB, with the piecewise curve (threshold 0.04045, as WCAG 2.2 corrects it). */
function linearizeSrgbChannel(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Returns the WCAG relative luminance of an sRGB colour, from 0 to 1. */
function computeRelativeLuminance(colour: ProbeColour): number {
  return (
    0.2126 * linearizeSrgbChannel(colour[0]) +
    0.7152 * linearizeSrgbChannel(colour[1]) +
    0.0722 * linearizeSrgbChannel(colour[2])
  );
}

/** Fails unless the colour is fully opaque: contrast against a see-through colour has no single answer, so callers blend first. */
function requireOpaque(colour: ProbeColour, name: string): void {
  if (colour[3] !== 1) {
    throw new Error(
      `The ${name} colour has alpha ${colour[3]}, but contrast needs an opaque colour. Blend it over the colour behind it with blendOver first.`,
    );
  }
}

/**
 * Returns `top` composited over `bottom` with source-over, in sRGB channel
 * space and with straight (not premultiplied) alpha, as a browser composites.
 * The result's alpha is `top + bottom * (1 - top)` (Porter-Duff), and the
 * channels are not rounded to whole numbers: the metrics keep the precision.
 * Where both are fully transparent the result is transparent black.
 */
export function blendOver(top: ProbeColour, bottom: ProbeColour): ProbeColour {
  const topAlpha = top[3];
  const bottomWeight = bottom[3] * (1 - topAlpha);
  const alpha = topAlpha + bottomWeight;
  if (alpha === 0) {
    return [0, 0, 0, 0];
  }
  const channel = (index: 0 | 1 | 2): number =>
    (top[index] * topAlpha + bottom[index] * bottomWeight) / alpha;
  return [channel(0), channel(1), channel(2), alpha];
}

/**
 * Returns `weightOfFirst * first + (1 - weightOfFirst) * second`, computed on
 * each of red, green, blue and alpha. This is what a group of opacity
 * `weightOfFirst` does to the colour of its content over `second`: use it when
 * the group's content is one flat colour. The channels are not rounded.
 */
export function mixColours(
  first: ProbeColour,
  second: ProbeColour,
  weightOfFirst: number,
): ProbeColour {
  const mix = (index: 0 | 1 | 2 | 3): number =>
    weightOfFirst * first[index] + (1 - weightOfFirst) * second[index];
  return [mix(0), mix(1), mix(2), mix(3)];
}

/**
 * Returns the luminance Y that APCA uses for an sRGB colour, from 0 to 1. APCA
 * linearises with a plain 2.4 exponent, not the piecewise sRGB curve, and
 * weighs the channels with its own coefficients. Luminances below a threshold
 * are raised, which models glare in the darkest colours.
 */
function computeApcaLuminance(colour: ProbeColour): number {
  const luminance =
    0.2126729 * (colour[0] / 255) ** 2.4 +
    0.7151522 * (colour[1] / 255) ** 2.4 +
    0.072175 * (colour[2] / 255) ** 2.4;
  const blackThreshold = 0.022;
  const blackClamp = 1.414;
  return luminance >= blackThreshold
    ? luminance
    : luminance + (blackThreshold - luminance) ** blackClamp;
}

/**
 * Returns the APCA lightness contrast Lc of `text` on `background`, signed as
 * APCA reports it: positive for dark text on a light background, negative for
 * light text on a dark one. Fails when either colour is not opaque.
 *
 * This is APCA-W3 version 0.0.98G-4g. Every constant is the one of the
 * reference implementation, github.com/Myndex/apca-w3, release 0.1.9.
 */
export function computeApcaContrast(text: ProbeColour, background: ProbeColour): number {
  requireOpaque(text, "text");
  requireOpaque(background, "background");
  const normalBackground = 0.56;
  const normalText = 0.57;
  const reverseText = 0.62;
  const reverseBackground = 0.65;
  const scale = 1.14;
  const offset = 0.027;
  const smallestLuminanceDifference = 0.0005;
  const smallestContrast = 0.1;

  const textLuminance = computeApcaLuminance(text);
  const backgroundLuminance = computeApcaLuminance(background);
  if (Math.abs(backgroundLuminance - textLuminance) < smallestLuminanceDifference) {
    return 0;
  }
  if (backgroundLuminance > textLuminance) {
    const contrast =
      (backgroundLuminance ** normalBackground - textLuminance ** normalText) * scale;
    return (contrast < smallestContrast ? 0 : contrast - offset) * 100;
  }
  const contrast =
    (backgroundLuminance ** reverseBackground - textLuminance ** reverseText) * scale;
  return (contrast > -smallestContrast ? 0 : contrast + offset) * 100;
}

/** Returns the WCAG 2.x contrast ratio of two colours, from 1 to 21, whichever is lighter. Fails when either colour is not opaque. */
export function computeWcagContrast(first: ProbeColour, second: ProbeColour): number {
  requireOpaque(first, "first");
  requireOpaque(second, "second");
  const firstLuminance = computeRelativeLuminance(first);
  const secondLuminance = computeRelativeLuminance(second);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Returns the lightness L of an opaque colour in OKLCH, from 0 (black) to 1
 * (white). It converts to linear sRGB, then to cone responses with Bjorn
 * Ottosson's OKLab matrix, takes the cube root, and weighs the three results
 * into L. Fails when the colour is not opaque.
 */
export function computeOklchLightness(colour: ProbeColour): number {
  requireOpaque(colour, "lightness");
  const red = linearizeSrgbChannel(colour[0]);
  const green = linearizeSrgbChannel(colour[1]);
  const blue = linearizeSrgbChannel(colour[2]);
  const long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short;
}

/**
 * Packs a colour into one unsigned 32-bit number, 0xRRGGBBAA, which is what
 * `Buffer.readUInt32BE` returns for a pixel of a PNG. Red, green and blue are
 * rounded to whole numbers and alpha (0 to 1) becomes 0 to 255, rounded. Use
 * it as a key when counting colours in a histogram.
 */
export function packColour(colour: ProbeColour): number {
  const red = Math.round(colour[0]);
  const green = Math.round(colour[1]);
  const blue = Math.round(colour[2]);
  const alpha = Math.round(colour[3] * 255);
  // The unsigned shift turns the signed result of the bit operations into a number from 0 to 2^32 - 1.
  return ((red << 24) | (green << 16) | (blue << 8) | alpha) >>> 0;
}

/** Returns the colour that a number from `packColour` stands for, with alpha converted back to 0 to 1. */
export function unpackColour(packed: number): ProbeColour {
  return [
    (packed >>> 24) & 0xff,
    (packed >>> 16) & 0xff,
    (packed >>> 8) & 0xff,
    (packed & 0xff) / 255,
  ];
}
