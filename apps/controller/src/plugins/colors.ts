/**
 * Turns the colours a plugin declares into the hex codes the apps draw.
 */
import type { ExactColor } from "@hercule/plugin-host";

/** Returns the hex code of one CSS colour, `#8250df` or `purple`, or `undefined` when it is no CSS colour. */
const convertCssColorToHex = (color: string): string | undefined =>
  Bun.color(color, "hex") ?? undefined;

/**
 * Returns `color` with every CSS colour name replaced by its hex code, so
 * `purple` becomes `#800080`, and every hex code in lower case with 6 digits.
 * Returns `undefined` when one of its colours is a word that is no CSS colour
 * name, such as `purpel`.
 *
 * The apps then receive hex codes only, so none of them needs the CSS list of
 * names.
 */
export const convertExactColorToHex = (color: ExactColor): ExactColor | undefined => {
  if (typeof color === "string") return convertCssColorToHex(color);
  const light = convertCssColorToHex(color.light);
  const dark = convertCssColorToHex(color.dark);
  return light === undefined || dark === undefined ? undefined : { light, dark };
};

/** Returns `color` in the words of an error message: `"purpel"`, or `{ light: "a", dark: "b" }`. */
export const describeExactColor = (color: ExactColor): string =>
  typeof color === "string" ? `"${color}"` : `{ light: "${color.light}", dark: "${color.dark}" }`;
